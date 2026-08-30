use std::collections::BTreeMap;
use std::sync::Arc;

use codex_extension_api::FunctionCallError;
use codex_extension_api::JsonToolOutput;
use codex_extension_api::ResponsesApiTool;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolName;
use codex_extension_api::ToolOutput;
use codex_extension_api::ToolSpec;
use codex_tools::AdditionalProperties;
use codex_tools::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

use crate::SpillSource;
use crate::SpillStore;

pub const READ_SPILL_TOOL_NAME: &str = "read_spill";
pub const GREP_SPILL_TOOL_NAME: &str = "grep_spill";

const DEFAULT_READ_BYTES: usize = 16 * 1024;
const HARD_MAX_READ_BYTES: usize = 64 * 1024;
const DEFAULT_MAX_MATCHES: usize = 20;
const HARD_MAX_MATCHES: usize = 50;
const HARD_MAX_QUERY_BYTES: usize = 4 * 1024;
const MATCH_SNIPPET_BYTES: usize = 1_024;
const RESPONSE_OVERHEAD_RESERVE: usize = 1_024;

#[derive(Clone)]
pub(crate) struct ReadSpillTool {
    store: Arc<dyn SpillStore>,
}

impl ReadSpillTool {
    pub(crate) fn new(store: Arc<dyn SpillStore>) -> Self {
        Self { store }
    }
}

#[derive(Clone)]
pub(crate) struct GrepSpillTool {
    store: Arc<dyn SpillStore>,
}

impl GrepSpillTool {
    pub(crate) fn new(store: Arc<dyn SpillStore>) -> Self {
        Self { store }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadSpillArgs {
    locator: String,
    offset_bytes: Option<usize>,
    max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GrepSpillArgs {
    locator: String,
    query: String,
    max_matches: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrepMatch {
    byte_offset: usize,
    snippet: String,
}

impl<'call> ToolExecutor<ToolCall<'call>> for ReadSpillTool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(READ_SPILL_TOOL_NAME)
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::Function(ResponsesApiTool {
            name: READ_SPILL_TOOL_NAME.to_string(),
            description: "Read an exact byte-range-safe UTF-8 chunk from a Zero3 spill locator returned by an oversized tool result.".to_string(),
            strict: false,
            defer_loading: None,
            parameters: read_spill_schema(),
            output_schema: None,
        })
    }

    fn handle<'a>(
        &'a self,
        invocation: ToolCall<'call>,
    ) -> codex_extension_api::ToolExecutorFuture<'a>
    where
        'call: 'a,
    {
        Box::pin(async move {
            let args: ReadSpillArgs = parse_args(invocation.function_arguments()?)?;
            let text = self
                .store
                .read_text(&args.locator)
                .await
                .map_err(store_error)?;
            let source = self
                .store
                .read_source(&args.locator)
                .await
                .map_err(store_error)?;
            let offset = args.offset_bytes.unwrap_or(0);
            if offset > text.len() || !text.is_char_boundary(offset) {
                return Err(FunctionCallError::RespondToModel(format!(
                    "offset_bytes must be a UTF-8 boundary between 0 and {}",
                    text.len()
                )));
            }

            let content_budget = response_content_budget(&invocation)?;
            let requested = args.max_bytes.unwrap_or(DEFAULT_READ_BYTES).max(1);
            let mut chunk_budget = requested.min(HARD_MAX_READ_BYTES).min(content_budget);

            loop {
                let (chunk, end) = read_utf8_chunk(&text, offset, chunk_budget).map_err(|required| {
                    FunctionCallError::RespondToModel(format!(
                        "max_bytes is too small for the next UTF-8 scalar; need at least {required} bytes"
                    ))
                })?;
                let next_offset_bytes = (end < text.len()).then_some(end);
                let value = read_response_value(
                    &args.locator,
                    &source,
                    text.len(),
                    offset,
                    chunk,
                    next_offset_bytes,
                );
                if value.to_string().len() <= content_budget {
                    return Ok(Box::new(JsonToolOutput::new(value)) as Box<dyn ToolOutput>);
                }
                if chunk.is_empty() || chunk.len() <= 1 {
                    return Err(FunctionCallError::RespondToModel(
                        "read_spill response metadata exceeds the current model response budget"
                            .to_string(),
                    ));
                }
                chunk_budget = chunk.len() - 1;
            }
        })
    }
}

impl<'call> ToolExecutor<ToolCall<'call>> for GrepSpillTool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(GREP_SPILL_TOOL_NAME)
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::Function(ResponsesApiTool {
            name: GREP_SPILL_TOOL_NAME.to_string(),
            description: "Search an exact retained Zero3 spill by literal UTF-8 text and return bounded snippets with byte offsets.".to_string(),
            strict: false,
            defer_loading: None,
            parameters: grep_spill_schema(),
            output_schema: None,
        })
    }

    fn handle<'a>(
        &'a self,
        invocation: ToolCall<'call>,
    ) -> codex_extension_api::ToolExecutorFuture<'a>
    where
        'call: 'a,
    {
        Box::pin(async move {
            let args: GrepSpillArgs = parse_args(invocation.function_arguments()?)?;
            if args.query.is_empty() {
                return Err(FunctionCallError::RespondToModel(
                    "query must not be empty".to_string(),
                ));
            }
            if args.query.len() > HARD_MAX_QUERY_BYTES {
                return Err(FunctionCallError::RespondToModel(format!(
                    "query exceeds the {HARD_MAX_QUERY_BYTES}-byte grep_spill limit"
                )));
            }
            let text = self
                .store
                .read_text(&args.locator)
                .await
                .map_err(store_error)?;
            let source = self
                .store
                .read_source(&args.locator)
                .await
                .map_err(store_error)?;
            let max_matches = args
                .max_matches
                .unwrap_or(DEFAULT_MAX_MATCHES)
                .clamp(1, HARD_MAX_MATCHES);
            let (mut matches, total_matches) = grep_literal(&text, &args.query, max_matches);
            let content_budget = response_content_budget(&invocation)?;

            loop {
                let value = grep_response_value(
                    &args.locator,
                    &args.query,
                    &source,
                    total_matches,
                    &matches,
                );
                if value.to_string().len() <= content_budget {
                    return Ok(Box::new(JsonToolOutput::new(value)) as Box<dyn ToolOutput>);
                }
                if matches.pop().is_none() {
                    return Err(FunctionCallError::RespondToModel(
                        "grep_spill response metadata exceeds the current model response budget"
                            .to_string(),
                    ));
                }
            }
        })
    }
}

fn parse_args<T>(arguments: &str) -> Result<T, FunctionCallError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str(arguments).map_err(|error| {
        FunctionCallError::RespondToModel(format!("invalid spill tool arguments: {error}"))
    })
}

fn store_error(error: std::io::Error) -> FunctionCallError {
    FunctionCallError::RespondToModel(format!("failed to read spill: {error}"))
}

fn response_content_budget(invocation: &ToolCall<'_>) -> Result<usize, FunctionCallError> {
    let budget = invocation
        .response_byte_budget(HARD_MAX_READ_BYTES)
        .saturating_sub(RESPONSE_OVERHEAD_RESERVE);
    if budget == 0 {
        return Err(FunctionCallError::RespondToModel(
            "current model response budget is too small for spill recovery metadata".to_string(),
        ));
    }
    Ok(budget)
}

fn read_response_value(
    locator: &str,
    source: &SpillSource,
    total_bytes: usize,
    offset_bytes: usize,
    text: &str,
    next_offset_bytes: Option<usize>,
) -> Value {
    json!({
        "locator": locator,
        "totalBytes": total_bytes,
        "offsetBytes": offset_bytes,
        "returnedBytes": text.len(),
        "nextOffsetBytes": next_offset_bytes,
        "source": source,
        "text": text,
    })
}

fn grep_response_value(
    locator: &str,
    query: &str,
    source: &SpillSource,
    total_matches: usize,
    matches: &[GrepMatch],
) -> Value {
    json!({
        "locator": locator,
        "query": query,
        "source": source,
        "totalMatches": total_matches,
        "returnedMatches": matches.len(),
        "truncated": total_matches > matches.len(),
        "matches": matches,
    })
}

fn read_spill_schema() -> JsonSchema {
    let mut properties = BTreeMap::new();
    properties.insert(
        "locator".to_string(),
        JsonSchema::string(Some("Opaque zero3-spill:// locator.".to_string())),
    );
    properties.insert(
        "offset_bytes".to_string(),
        JsonSchema::integer(Some(
            "UTF-8 byte boundary to start reading from; defaults to 0.".to_string(),
        )),
    );
    properties.insert(
        "max_bytes".to_string(),
        JsonSchema::integer(Some(
            "Maximum UTF-8 bytes to return; bounded by the host response budget.".to_string(),
        )),
    );
    JsonSchema::object(
        properties,
        Some(vec!["locator".to_string()]),
        Some(AdditionalProperties::Boolean(false)),
    )
}

fn grep_spill_schema() -> JsonSchema {
    let mut properties = BTreeMap::new();
    properties.insert(
        "locator".to_string(),
        JsonSchema::string(Some("Opaque zero3-spill:// locator.".to_string())),
    );
    properties.insert(
        "query".to_string(),
        JsonSchema::string(Some("Literal UTF-8 text to search for.".to_string())),
    );
    properties.insert(
        "max_matches".to_string(),
        JsonSchema::integer(Some("Maximum returned matches, from 1 to 50.".to_string())),
    );
    JsonSchema::object(
        properties,
        Some(vec!["locator".to_string(), "query".to_string()]),
        Some(AdditionalProperties::Boolean(false)),
    )
}

fn read_utf8_chunk(text: &str, offset: usize, max_bytes: usize) -> Result<(&str, usize), usize> {
    if offset >= text.len() {
        return Ok(("", offset));
    }
    let next_scalar_bytes = text[offset..]
        .chars()
        .next()
        .map(char::len_utf8)
        .unwrap_or(0);
    if max_bytes < next_scalar_bytes {
        return Err(next_scalar_bytes);
    }

    let mut end = offset.saturating_add(max_bytes).min(text.len());
    while end > offset && !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok((&text[offset..end], end))
}

fn grep_literal(text: &str, query: &str, max_matches: usize) -> (Vec<GrepMatch>, usize) {
    let mut matches = Vec::new();
    let mut total_matches = 0usize;
    for (byte_offset, _) in text.match_indices(query) {
        total_matches = total_matches.saturating_add(1);
        if matches.len() < max_matches {
            matches.push(GrepMatch {
                byte_offset,
                snippet: match_snippet(text, byte_offset, query.len(), MATCH_SNIPPET_BYTES),
            });
        }
    }
    (matches, total_matches)
}

fn match_snippet(text: &str, match_start: usize, match_len: usize, budget: usize) -> String {
    if text.len() <= budget {
        return text.to_string();
    }

    let left_budget = budget / 2;
    let right_budget = budget.saturating_sub(left_budget);
    let mut start = match_start.saturating_sub(left_budget);
    while start < match_start && !text.is_char_boundary(start) {
        start += 1;
    }
    let match_end = match_start.saturating_add(match_len).min(text.len());
    let mut end = match_end.saturating_add(right_budget).min(text.len());
    while end > match_end && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[start..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_chunk_never_splits_multibyte_utf8() {
        let text = "A中🙂B";
        let (first, next) = read_utf8_chunk(text, 0, 3).expect("ascii fits");
        assert_eq!(first, "A");
        assert_eq!(next, 1);
        let (second, _) = read_utf8_chunk(text, next, 4).expect("Chinese scalar fits");
        assert_eq!(second, "中");
    }

    #[test]
    fn read_chunk_never_exceeds_hard_byte_cap_for_multibyte_scalar() {
        assert_eq!(read_utf8_chunk("中", 0, 1), Err(3));
        assert_eq!(read_utf8_chunk("🙂", 0, 3), Err(4));
    }

    #[test]
    fn grep_finds_middle_keyword_and_caps_returned_matches() {
        let text = format!(
            "{}MIDDLE-零三-🙂{}MIDDLE-零三-🙂",
            "x".repeat(10_000),
            "y".repeat(10_000)
        );
        let (matches, total) = grep_literal(&text, "MIDDLE-零三-🙂", 1);
        assert_eq!(total, 2);
        assert_eq!(matches.len(), 1);
        assert!(matches[0].snippet.contains("MIDDLE-零三-🙂"));
        assert!(matches[0].snippet.len() <= MATCH_SNIPPET_BYTES + "MIDDLE-零三-🙂".len());
    }

    #[test]
    fn grep_response_can_drop_matches_until_serialized_payload_fits() {
        let source = SpillSource {
            thread_id: "thread".to_string(),
            turn_id: "turn".to_string(),
            call_id: "call".to_string(),
            tool_name: "tool".to_string(),
        };
        let (mut matches, total) = grep_literal(&"x\n".repeat(20_000), "x", 50);
        let budget = 2_048;
        while grep_response_value("zero3-spill://v1/abc", "x", &source, total, &matches)
            .to_string()
            .len()
            > budget
        {
            assert!(matches.pop().is_some());
        }
        assert!(
            grep_response_value("zero3-spill://v1/abc", "x", &source, total, &matches)
                .to_string()
                .len()
                <= budget
        );
    }
}
