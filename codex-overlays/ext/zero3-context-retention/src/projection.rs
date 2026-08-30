use codex_extension_api::CompactionHistoryItemInput;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::ResponseItem;
use codex_zero3_output_retention::SpillStore;

use crate::ContentBlock;
use crate::PruneConfig;
use crate::ToolResultEnvelope;
use crate::prune_tool_result;

const D1_SPILL_LOCATOR_PREFIX: &str = "zero3-spill://v1/";

pub(crate) async fn project_compaction_history_item(
    store: &dyn SpillStore,
    config: PruneConfig,
    input: CompactionHistoryItemInput<'_>,
) -> Result<Option<ResponseItem>, String> {
    let Some((call_id, current_text)) = plain_tool_output(input.item) else {
        return Ok(None);
    };
    if current_text.chars().count() <= config.threshold_chars {
        return Ok(None);
    }

    let thread_id = input.thread_store.level_id().to_string();
    let Some(locator) =
        verified_recovery_locator(store, current_text, &thread_id, input.turn_id, call_id).await
    else {
        return Ok(None);
    };

    let envelope = ToolResultEnvelope {
        call_id: call_id.to_owned(),
        content: vec![ContentBlock::<()>::Text {
            text: current_text.to_owned(),
        }],
        recovery_ref: Some(locator.clone()),
    };
    let Some(pruned) = prune_tool_result(&envelope, config).map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };

    let projected_text = pruned
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Rich(_) => None,
        })
        .collect::<String>();

    // The D1 recovery reference must remain visible after pruning. D1 currently
    // places its notice at the tail, but D2 verifies the invariant rather than
    // binding to the rest of that notice text.
    if !projected_text.contains(&locator) {
        return Ok(None);
    }

    tracing::debug!(
        call_id,
        recovery_locator = %locator,
        policy_version = pruned.provenance.policy_version,
        original_chars = pruned.provenance.original_chars,
        retained_chars = pruned.provenance.retained_chars,
        removed_chars = pruned.provenance.removed_chars,
        net_chars_saved = pruned.provenance.net_chars_saved,
        "projected recoverable historical tool result for compaction"
    );

    Ok(replace_plain_tool_output(input.item, projected_text))
}

async fn verified_recovery_locator(
    store: &dyn SpillStore,
    text: &str,
    thread_id: &str,
    turn_id: Option<&str>,
    call_id: &str,
) -> Option<String> {
    // Prefer the newest candidate because D1 appends its recovery notice after
    // the retained tail. Every candidate is verified through both frozen D1
    // provenance and an actual full-text read before D2 treats the item as
    // recoverable. Metadata alone is insufficient because LocalSpillStore keeps
    // source and text in separate files.
    for candidate in spill_locator_candidates(text).into_iter().rev() {
        let Ok(source) = store.read_source(candidate).await else {
            continue;
        };
        if source.thread_id != thread_id || source.call_id != call_id {
            continue;
        }
        if let Some(turn_id) = turn_id
            && source.turn_id != turn_id
        {
            continue;
        }
        if store.read_text(candidate).await.is_err() {
            continue;
        }
        return Some(candidate.to_owned());
    }
    None
}

fn spill_locator_candidates(text: &str) -> Vec<&str> {
    let mut candidates = Vec::new();
    let mut cursor = 0usize;
    while cursor < text.len() {
        let Some(relative_start) = text[cursor..].find(D1_SPILL_LOCATOR_PREFIX) else {
            break;
        };
        let start = cursor + relative_start;
        let rest = &text[start..];
        let end = rest
            .find(|character: char| {
                character.is_whitespace()
                    || matches!(character, ']' | ';' | ',' | ')' | '>' | '"' | '\'')
            })
            .unwrap_or(rest.len());
        let candidate = &rest[..end];
        if candidate.len() > D1_SPILL_LOCATOR_PREFIX.len() {
            candidates.push(candidate);
        }
        cursor = start.saturating_add(D1_SPILL_LOCATOR_PREFIX.len());
    }
    candidates
}

fn plain_tool_output(item: &ResponseItem) -> Option<(&str, &str)> {
    match item {
        ResponseItem::FunctionCallOutput {
            call_id: Some(call_id),
            output,
            ..
        } => match &output.body {
            FunctionCallOutputBody::Text(text) => Some((call_id.as_str(), text.as_str())),
            FunctionCallOutputBody::ContentItems(_) => None,
        },
        ResponseItem::CustomToolCallOutput {
            call_id, output, ..
        } => match &output.body {
            FunctionCallOutputBody::Text(text) => Some((call_id.as_str(), text.as_str())),
            FunctionCallOutputBody::ContentItems(_) => None,
        },
        _ => None,
    }
}

fn replace_plain_tool_output(item: &ResponseItem, text: String) -> Option<ResponseItem> {
    let mut projected = item.clone();
    match &mut projected {
        ResponseItem::FunctionCallOutput { output, .. }
        | ResponseItem::CustomToolCallOutput { output, .. } => {
            if !matches!(output.body, FunctionCallOutputBody::Text(_)) {
                return None;
            }
            output.body = FunctionCallOutputBody::Text(text);
            Some(projected)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use codex_zero3_output_retention::SpillFuture;
    use codex_zero3_output_retention::SpillRef;
    use codex_zero3_output_retention::SpillSource;

    use super::*;

    struct FakeStore {
        locator: String,
        source: SpillSource,
        text_available: bool,
    }

    impl SpillStore for FakeStore {
        fn save_text<'a>(
            &'a self,
            _source: &'a SpillSource,
            _text: &'a str,
        ) -> SpillFuture<'a, SpillRef> {
            Box::pin(async {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "save not used by D2 projection tests",
                ))
            })
        }

        fn read_text<'a>(&'a self, locator: &'a str) -> SpillFuture<'a, String> {
            Box::pin(async move {
                if locator == self.locator && self.text_available {
                    Ok("complete spilled output".to_owned())
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::NotFound,
                        "spill text unavailable",
                    ))
                }
            })
        }

        fn read_source<'a>(&'a self, locator: &'a str) -> SpillFuture<'a, SpillSource> {
            Box::pin(async move {
                if locator == self.locator {
                    Ok(self.source.clone())
                } else {
                    Err(io::Error::new(io::ErrorKind::NotFound, "unknown locator"))
                }
            })
        }
    }

    fn fake_store(call_id: &str) -> FakeStore {
        FakeStore {
            locator: "zero3-spill://v1/1a-2b-3c".to_owned(),
            source: SpillSource {
                thread_id: "thread-1".to_owned(),
                turn_id: "turn-1".to_owned(),
                call_id: call_id.to_owned(),
                tool_name: "exec_command".to_owned(),
            },
            text_available: true,
        }
    }

    #[test]
    fn extracts_locator_without_binding_to_full_notice_text() {
        let text = "prefix zero3-spill://v1/1a-2b-3c; recover with read_spill";
        assert_eq!(
            spill_locator_candidates(text),
            vec!["zero3-spill://v1/1a-2b-3c"]
        );
    }

    #[test]
    fn ignores_empty_locator_suffix() {
        assert!(spill_locator_candidates("zero3-spill://v1/ ]").is_empty());
    }

    #[tokio::test]
    async fn accepts_only_a_real_sidecar_for_the_same_history_identity() {
        let store = fake_store("call-7");
        let text = format!("preview {} ; recover", store.locator);
        let verified =
            verified_recovery_locator(&store, &text, "thread-1", Some("turn-1"), "call-7").await;
        assert_eq!(verified.as_deref(), Some(store.locator.as_str()));
    }

    #[tokio::test]
    async fn metadata_without_recoverable_text_fails_closed() {
        let mut store = fake_store("call-7");
        store.text_available = false;
        let text = format!("preview {} ; recover", store.locator);
        assert!(
            verified_recovery_locator(&store, &text, "thread-1", Some("turn-1"), "call-7",)
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn fake_or_cross_call_locator_fails_closed() {
        let store = fake_store("different-call");
        let text = format!("preview {} ; recover", store.locator);
        assert!(
            verified_recovery_locator(&store, &text, "thread-1", Some("turn-1"), "call-7",)
                .await
                .is_none()
        );
        assert!(
            verified_recovery_locator(
                &store,
                "preview zero3-spill://v1/dead-beef; recover",
                "thread-1",
                Some("turn-1"),
                "different-call",
            )
            .await
            .is_none()
        );
    }
}
