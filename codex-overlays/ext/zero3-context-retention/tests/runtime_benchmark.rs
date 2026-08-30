use codex_utils_output_truncation::approx_token_count;
use codex_zero3_context_retention::{
    ContentBlock, PruneConfig, ToolResultEnvelope, prune_tool_result,
};
use codex_zero3_output_retention::{
    LocalSpillStore, RetentionOutcome, SpillSource, SpillStore, retain_text,
};

const TOTAL_RESULTS: usize = 100;
const OVERSIZED_RESULTS: usize = 20;
const OVERSIZED_CHARS: usize = 100_000;
const NORMAL_CHARS: usize = 1_024;
const D1_INLINE_BYTES: usize = 16 * 1024;
const PLANNING_CONTEXT_BUDGET: usize = 128_000;

fn source(index: usize) -> SpillSource {
    SpillSource {
        thread_id: "runtime-benchmark-thread".to_string(),
        turn_id: format!("turn-{index:03}"),
        call_id: format!("call-{index:03}"),
        tool_name: "runtime_benchmark".to_string(),
    }
}

fn oversized_text(index: usize) -> (String, String) {
    let fact = format!("ZERO3_MIDDLE_FACT_{index:03}");
    let fact_chars = fact.chars().count();
    let head_chars = (OVERSIZED_CHARS - fact_chars) / 2;
    let tail_chars = OVERSIZED_CHARS - fact_chars - head_chars;
    let text = format!("{}{}{}", "A".repeat(head_chars), fact, "Z".repeat(tail_chars));
    assert_eq!(text.chars().count(), OVERSIZED_CHARS);
    (text, fact)
}

fn flatten_text(blocks: &[ContentBlock<()>]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Rich(()) => None,
        })
        .collect::<String>()
}

#[tokio::test]
async fn integrated_100_20_uses_codex_token_accounting_and_recovers_all_spills() {
    let dir = tempfile::tempdir().expect("benchmark temp dir");
    let store = LocalSpillStore::new(dir.path());
    let prune_config = PruneConfig::default();

    let mut original_codex_tokens = 0usize;
    let mut d1_codex_tokens = 0usize;
    let mut d2_codex_tokens = 0usize;
    let mut spilled = 0usize;
    let mut pruned = 0usize;
    let mut recovered = 0usize;

    for index in 0..TOTAL_RESULTS {
        let call_source = source(index);
        let (original, expected_fact) = if index < OVERSIZED_RESULTS {
            oversized_text(index)
        } else {
            ("n".repeat(NORMAL_CHARS), format!("NORMAL_{index:03}"))
        };

        original_codex_tokens = original_codex_tokens.saturating_add(approx_token_count(&original));
        let retained = retain_text(&store, &call_source, &original, D1_INLINE_BYTES).await;

        match retained {
            RetentionOutcome::Inline(text) => {
                assert!(index >= OVERSIZED_RESULTS, "oversized fixture must be D1-spilled");
                d1_codex_tokens = d1_codex_tokens.saturating_add(approx_token_count(&text));
                d2_codex_tokens = d2_codex_tokens.saturating_add(approx_token_count(&text));
                let envelope = ToolResultEnvelope::<(), String> {
                    call_id: call_source.call_id.clone(),
                    content: vec![ContentBlock::Text { text }],
                    recovery_ref: None,
                };
                assert!(
                    prune_tool_result(&envelope, prune_config)
                        .expect("normal result pruning must not error")
                        .is_none(),
                    "normal unrecoverable result must remain untouched"
                );
            }
            RetentionOutcome::Spilled {
                projection,
                reference,
                ..
            } => {
                assert!(index < OVERSIZED_RESULTS, "normal fixture must remain inline");
                spilled += 1;
                assert!(projection.contains(&reference.locator));
                d1_codex_tokens = d1_codex_tokens.saturating_add(approx_token_count(&projection));

                let envelope = ToolResultEnvelope::<(), _> {
                    call_id: call_source.call_id.clone(),
                    content: vec![ContentBlock::Text {
                        text: projection.clone(),
                    }],
                    recovery_ref: Some(reference.clone()),
                };
                let projected = prune_tool_result(&envelope, prune_config)
                    .expect("recoverable historical result pruning must not error")
                    .expect("D1 projection above the D2 threshold must prune");
                pruned += 1;

                let d2_text = flatten_text(&projected.content);
                assert!(d2_text.contains(&reference.locator));
                assert!(d2_text.chars().count() <= prune_config.threshold_chars);
                d2_codex_tokens = d2_codex_tokens.saturating_add(approx_token_count(&d2_text));

                let recovered_text = store
                    .read_text(&reference.locator)
                    .await
                    .expect("D1 spill must be readable after D2 projection");
                let recovered_source = store
                    .read_source(&reference.locator)
                    .await
                    .expect("D1 spill metadata must remain readable");
                assert_eq!(recovered_source, call_source);
                assert_eq!(recovered_text, original);
                assert!(recovered_text.contains(&expected_fact));
                assert!(
                    !d2_text.contains(&expected_fact),
                    "middle fact must genuinely require D1 recovery rather than surviving the preview"
                );
                recovered += 1;
            }
        }
    }

    assert_eq!(spilled, OVERSIZED_RESULTS);
    assert_eq!(pruned, OVERSIZED_RESULTS);
    assert_eq!(recovered, OVERSIZED_RESULTS);
    assert!(original_codex_tokens > PLANNING_CONTEXT_BUDGET);
    assert!(d1_codex_tokens < original_codex_tokens);
    assert!(d2_codex_tokens < d1_codex_tokens);
    assert!(d2_codex_tokens < PLANNING_CONTEXT_BUDGET);

    println!(
        "ZERO3_D2_RUNTIME_100_20 total_results={TOTAL_RESULTS} oversized={OVERSIZED_RESULTS} spilled={spilled} pruned={pruned} recovered={recovered} original_codex_approx_tokens={original_codex_tokens} d1_codex_approx_tokens={d1_codex_tokens} d2_codex_approx_tokens={d2_codex_tokens} context_budget={PLANNING_CONTEXT_BUDGET}"
    );
}
