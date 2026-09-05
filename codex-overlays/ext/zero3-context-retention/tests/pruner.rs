use codex_zero3_context_retention::{
    ContentBlock, PRUNE_MARKER, PruneConfig, ToolResultEnvelope, measure_content, prune_content,
    prune_tool_result,
};

fn small_config() -> PruneConfig {
    PruneConfig {
        threshold_chars: 64,
        head_chars: 8,
        tail_chars: 6,
    }
}

#[test]
fn short_content_is_not_pruned() {
    let blocks = vec![ContentBlock::<&'static str>::Text {
        text: "short output".to_owned(),
    }];
    assert_eq!(prune_content(&blocks, small_config()).unwrap(), None);
}

#[test]
fn unicode_slicing_is_scalar_safe() {
    let input = "😀中".repeat(80);
    let blocks = vec![ContentBlock::<&'static str>::Text { text: input }];
    let pruned = prune_content(&blocks, small_config())
        .unwrap()
        .expect("oversized text must prune");

    assert!(measure_content(&pruned.content) <= small_config().threshold_chars);
    let ContentBlock::Text { text } = &pruned.content[0] else {
        panic!("expected text block");
    };
    assert!(text.contains(PRUNE_MARKER));
    assert!(!text.contains('\u{fffd}'));
}

#[test]
fn rich_blocks_keep_relative_order_across_removed_middle() {
    let blocks = vec![
        ContentBlock::Text {
            text: "A".repeat(40),
        },
        ContentBlock::Rich("reasoning-a"),
        ContentBlock::Text {
            text: "B".repeat(40),
        },
        ContentBlock::Rich("tool-call-b"),
        ContentBlock::Text {
            text: "C".repeat(40),
        },
    ];

    let pruned = prune_content(&blocks, small_config())
        .unwrap()
        .expect("oversized content must prune");
    let rich: Vec<_> = pruned
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Rich(value) => Some(*value),
            ContentBlock::Text { .. } => None,
        })
        .collect();

    assert_eq!(rich, vec!["reasoning-a", "tool-call-b"]);
    assert_eq!(pruned.provenance.marker_count, 1);
}

#[test]
fn provenance_distinguishes_excised_original_span_from_net_savings() {
    let config = small_config();
    let original_chars = 200;
    let blocks = vec![ContentBlock::<()>::Text {
        text: "x".repeat(original_chars),
    }];
    let pruned = prune_content(&blocks, config)
        .unwrap()
        .expect("oversized content must prune");

    assert_eq!(pruned.provenance.original_chars, original_chars);
    assert_eq!(
        pruned.provenance.removed_chars,
        original_chars - config.head_chars - config.tail_chars
    );
    assert_eq!(
        pruned.provenance.net_chars_saved,
        original_chars - pruned.provenance.retained_chars
    );
    assert_eq!(
        pruned.provenance.retained_chars,
        config.head_chars + PRUNE_MARKER.chars().count() + config.tail_chars
    );
    assert!(pruned.provenance.removed_chars > pruned.provenance.net_chars_saved);
}

#[test]
fn same_input_produces_identical_output_and_provenance() {
    let blocks = vec![ContentBlock::<()>::Text {
        text: "deterministic".repeat(40),
    }];
    let first = prune_content(&blocks, small_config()).unwrap();
    let second = prune_content(&blocks, small_config()).unwrap();
    assert_eq!(first, second);
}

#[test]
fn pruned_output_converges_without_a_second_marker() {
    let blocks = vec![ContentBlock::<()>::Text {
        text: "convergent".repeat(40),
    }];
    let first = prune_content(&blocks, small_config())
        .unwrap()
        .expect("oversized content must prune once");
    let projected_text = first
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Rich(_) => None,
        })
        .collect::<String>();

    assert_eq!(projected_text.matches(PRUNE_MARKER).count(), 1);
    assert_eq!(prune_content(&first.content, small_config()).unwrap(), None);
}

#[test]
fn tool_result_without_recovery_reference_fails_closed() {
    let result = ToolResultEnvelope::<(), &'static str> {
        call_id: "call-unspilled".to_owned(),
        content: vec![ContentBlock::Text {
            text: "x".repeat(200),
        }],
        recovery_ref: None,
    };

    assert_eq!(prune_tool_result(&result, small_config()).unwrap(), None);
}

#[test]
fn opaque_recovery_reference_and_call_pairing_survive_pruning() {
    #[derive(Clone, Debug, PartialEq, Eq)]
    struct FrozenD1Ref(&'static str);

    let result = ToolResultEnvelope {
        call_id: "call-17".to_owned(),
        content: vec![ContentBlock::<()>::Text {
            text: "x".repeat(200),
        }],
        recovery_ref: Some(FrozenD1Ref("opaque://spill/17")),
    };

    let pruned = prune_tool_result(&result, small_config())
        .unwrap()
        .expect("oversized tool result must prune");
    assert_eq!(pruned.call_id, result.call_id);
    assert_eq!(pruned.recovery_ref, result.recovery_ref);
}

#[test]
fn invalid_budget_is_rejected() {
    let config = PruneConfig {
        threshold_chars: 32,
        head_chars: 20,
        tail_chars: 20,
    };
    let blocks = vec![ContentBlock::<()>::Text {
        text: "x".repeat(100),
    }];
    assert!(prune_content(&blocks, config).is_err());
}
