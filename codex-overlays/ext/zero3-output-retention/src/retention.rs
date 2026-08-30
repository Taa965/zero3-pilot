use crate::SpillRef;
use crate::SpillSource;
use crate::SpillStore;

const PREVIEW_SEPARATOR: &str = "\n...\n";
const NOTICE_SEPARATOR: &str = "\n\n";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RetentionOutcome {
    Inline(String),
    Spilled {
        projection: String,
        reference: SpillRef,
        omitted_bytes: usize,
    },
}

impl RetentionOutcome {
    pub fn model_text(&self) -> &str {
        match self {
            Self::Inline(text) => text,
            Self::Spilled { projection, .. } => projection,
        }
    }

    pub fn spill_ref(&self) -> Option<&SpillRef> {
        match self {
            Self::Inline(_) => None,
            Self::Spilled { reference, .. } => Some(reference),
        }
    }
}

/// Retain an oversized UTF-8 tool result without changing execution success.
///
/// Storage is attempted before any lossy projection is produced. If storage
/// fails, or even the recovery notice cannot fit inside `max_inline_bytes`, the
/// exact original text is returned inline. A retention failure must never turn
/// a successful Codex tool call into an error or hide its result.
pub async fn retain_text(
    store: &dyn SpillStore,
    source: &SpillSource,
    text: &str,
    max_inline_bytes: usize,
) -> RetentionOutcome {
    let total_bytes = text.len();
    if total_bytes <= max_inline_bytes {
        return RetentionOutcome::Inline(text.to_string());
    }

    let reference = match store.save_text(source, text).await {
        Ok(reference) => reference,
        Err(error) => {
            tracing::warn!(
                tool_name = source.tool_name,
                call_id = source.call_id,
                %error,
                "output retention storage failed; keeping full result inline"
            );
            return RetentionOutcome::Inline(text.to_string());
        }
    };

    // Price the notice using the largest possible omission count. The real
    // omitted count can only have the same or fewer decimal digits, so this is
    // a safe reservation and avoids a circular preview-budget calculation.
    let worst_notice = spill_notice(total_bytes, &reference);
    if worst_notice.len() > max_inline_bytes {
        tracing::warn!(
            tool_name = source.tool_name,
            call_id = source.call_id,
            max_inline_bytes,
            "output retention notice exceeds inline budget; keeping full result inline"
        );
        return RetentionOutcome::Inline(text.to_string());
    }

    let reserved = worst_notice
        .len()
        .saturating_add(NOTICE_SEPARATOR.len())
        .saturating_add(PREVIEW_SEPARATOR.len());
    let preview_budget = max_inline_bytes.saturating_sub(reserved);
    let head_budget = preview_budget.div_ceil(2);
    let tail_budget = preview_budget / 2;
    let head = utf8_prefix(text, head_budget);
    let tail = utf8_suffix(text, tail_budget);
    let retained_bytes = head.len().saturating_add(tail.len()).min(total_bytes);
    let omitted_bytes = total_bytes.saturating_sub(retained_bytes);
    let notice = spill_notice(omitted_bytes, &reference);

    let preview = match (head.is_empty(), tail.is_empty()) {
        (false, false) => format!("{head}{PREVIEW_SEPARATOR}{tail}"),
        (false, true) => head.to_string(),
        (true, false) => tail.to_string(),
        (true, true) => String::new(),
    };
    let projection = if preview.is_empty() {
        notice
    } else {
        format!("{preview}{NOTICE_SEPARATOR}{notice}")
    };

    if projection.len() > max_inline_bytes {
        // This should be unreachable because the worst-case notice and both
        // separators were reserved before slicing. Keep the safety property
        // explicit instead of relying on an assertion in production.
        tracing::warn!(
            tool_name = source.tool_name,
            call_id = source.call_id,
            projection_bytes = projection.len(),
            max_inline_bytes,
            "output retention projection exceeded budget; keeping full result inline"
        );
        return RetentionOutcome::Inline(text.to_string());
    }

    RetentionOutcome::Spilled {
        projection,
        reference,
        omitted_bytes,
    }
}

fn spill_notice(omitted_bytes: usize, reference: &SpillRef) -> String {
    format!(
        "[zero3 spill: {omitted_bytes} UTF-8 bytes omitted; full result: {}; recover with read_spill or grep_spill]",
        reference.locator
    )
}

fn utf8_prefix(text: &str, budget: usize) -> &str {
    if budget >= text.len() {
        return text;
    }
    let mut end = budget;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn utf8_suffix(text: &str, budget: usize) -> &str {
    if budget >= text.len() {
        return text;
    }
    let mut start = text.len().saturating_sub(budget);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;
    use crate::LocalSpillStore;
    use crate::SpillFuture;

    fn source() -> SpillSource {
        SpillSource {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            call_id: "call-1".to_string(),
            tool_name: "synthetic_output".to_string(),
        }
    }

    struct FailingStore;

    impl SpillStore for FailingStore {
        fn save_text<'a>(
            &'a self,
            _source: &'a SpillSource,
            _text: &'a str,
        ) -> SpillFuture<'a, SpillRef> {
            Box::pin(async { Err(io::Error::other("disk unavailable")) })
        }

        fn read_text<'a>(&'a self, _locator: &'a str) -> SpillFuture<'a, String> {
            Box::pin(async { Err(io::Error::other("disk unavailable")) })
        }

        fn read_source<'a>(&'a self, _locator: &'a str) -> SpillFuture<'a, SpillSource> {
            Box::pin(async { Err(io::Error::other("disk unavailable")) })
        }
    }

    async fn assert_spill_round_trip(text: String, cap: usize) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = LocalSpillStore::new(dir.path());
        let outcome = retain_text(&store, &source(), &text, cap).await;
        let RetentionOutcome::Spilled {
            projection,
            reference,
            omitted_bytes,
        } = outcome
        else {
            panic!("expected spill");
        };

        assert!(projection.len() <= cap);
        assert!(projection.contains("read_spill"));
        assert!(projection.contains("grep_spill"));
        assert!(omitted_bytes > 0);
        assert_eq!(reference.byte_len, text.len());
        assert_eq!(store.read_text(&reference.locator).await.unwrap(), text);
        assert_eq!(
            store.read_source(&reference.locator).await.unwrap(),
            source()
        );
    }

    #[tokio::test]
    async fn keeps_small_output_inline() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = LocalSpillStore::new(dir.path());
        let text = "a".repeat(1_024);
        assert_eq!(
            retain_text(&store, &source(), &text, 1_024).await,
            RetentionOutcome::Inline(text)
        );
    }

    #[tokio::test]
    async fn recovers_100kb_output_exactly() {
        assert_spill_round_trip("0123456789".repeat(10_240), 8_192).await;
    }

    #[tokio::test]
    async fn recovers_1mb_output_exactly_with_middle_keyword() {
        let mut text = "A".repeat(512 * 1_024);
        text.push_str("MIDDLE-KEYWORD-零三-🙂");
        text.push_str(&"Z".repeat(512 * 1_024));
        assert_spill_round_trip(text, 16_384).await;
    }

    #[tokio::test]
    async fn chinese_and_emoji_projection_respects_exact_utf8_budget() {
        let text = "中文🙂Hermes🚀".repeat(20_000);
        let dir = tempfile::tempdir().expect("temp dir");
        let store = LocalSpillStore::new(dir.path());
        let cap = 4_097;
        let outcome = retain_text(&store, &source(), &text, cap).await;

        let RetentionOutcome::Spilled { projection, .. } = outcome else {
            panic!("expected spill");
        };
        assert!(projection.len() <= cap);
        assert!(std::str::from_utf8(projection.as_bytes()).is_ok());
    }

    #[tokio::test]
    async fn storage_failure_is_fail_open() {
        let text = "x".repeat(100_000);
        let outcome = retain_text(&FailingStore, &source(), &text, 4_096).await;
        assert_eq!(outcome, RetentionOutcome::Inline(text));
    }
}
