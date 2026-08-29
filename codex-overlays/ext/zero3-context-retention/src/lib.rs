//! Deterministic, model-free pruning primitives for historical tool results.
//!
//! This crate intentionally does not integrate with Codex compaction yet. D2B
//! must consume the D1 output-retention contract after S0 freezes it. The
//! generic `RecoveryRef` parameter lets the later adapter preserve D1's
//! authoritative spill reference without defining a competing SpillRef here.

use std::error::Error;
use std::fmt::{Display, Formatter};

pub const PRUNE_MARKER: &str = "\n\n[... tool result middle pruned ...]\n\n";
pub const POLICY_VERSION: &str = "zero3-context-retention/v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PruneConfig {
    pub threshold_chars: usize,
    pub head_chars: usize,
    pub tail_chars: usize,
}

impl Default for PruneConfig {
    fn default() -> Self {
        Self {
            threshold_chars: 8_192,
            head_chars: 4_096,
            tail_chars: 1_024,
        }
    }
}

impl PruneConfig {
    pub fn validate(self) -> Result<Self, PruneError> {
        if self.threshold_chars == 0 {
            return Err(PruneError::InvalidConfig(
                "threshold_chars must be greater than zero".to_owned(),
            ));
        }
        let emitted = self
            .head_chars
            .checked_add(PRUNE_MARKER.chars().count())
            .and_then(|value| value.checked_add(self.tail_chars))
            .ok_or_else(|| PruneError::InvalidConfig("character budget overflow".to_owned()))?;
        if emitted > self.threshold_chars {
            return Err(PruneError::InvalidConfig(format!(
                "head + marker + tail ({emitted}) exceeds threshold ({})",
                self.threshold_chars
            )));
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContentBlock<Rich> {
    Text { text: String },
    Rich(Rich),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolResultEnvelope<Rich, RecoveryRef> {
    pub call_id: String,
    pub content: Vec<ContentBlock<Rich>>,
    /// Opaque to D2. The D1 adapter will supply its frozen recovery-reference type.
    pub recovery_ref: Option<RecoveryRef>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PruneProvenance {
    pub policy_version: &'static str,
    pub original_chars: usize,
    pub retained_chars: usize,
    pub removed_chars: usize,
    pub marker_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrunedContent<Rich> {
    pub content: Vec<ContentBlock<Rich>>,
    pub provenance: PruneProvenance,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrunedToolResult<Rich, RecoveryRef> {
    pub call_id: String,
    pub content: Vec<ContentBlock<Rich>>,
    pub recovery_ref: Option<RecoveryRef>,
    pub provenance: PruneProvenance,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PruneError {
    InvalidConfig(String),
    Invariant(String),
}

impl Display for PruneError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(message) => write!(f, "invalid prune config: {message}"),
            Self::Invariant(message) => write!(f, "prune invariant failed: {message}"),
        }
    }
}

impl Error for PruneError {}

/// Counts Unicode scalar values across text blocks. Rich blocks cost zero here;
/// token pricing belongs to the Codex integration layer rather than this engine.
pub fn measure_content<Rich>(blocks: &[ContentBlock<Rich>]) -> usize {
    blocks
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text.chars().count(),
            ContentBlock::Rich(_) => 0,
        })
        .sum()
}

/// Deterministically removes one logical middle span from all text blocks while
/// preserving rich blocks and their relative order.
pub fn prune_content<Rich: Clone>(
    blocks: &[ContentBlock<Rich>],
    config: PruneConfig,
) -> Result<Option<PrunedContent<Rich>>, PruneError> {
    let config = config.validate()?;
    let total_chars = measure_content(blocks);
    if total_chars <= config.threshold_chars {
        return Ok(None);
    }

    // Validation plus total_chars > threshold guarantees a non-empty removed span.
    let removed_start = config.head_chars;
    let removed_end = total_chars - config.tail_chars;
    let mut output = Vec::with_capacity(blocks.len());
    let mut consumed = 0usize;
    let mut marker_inserted = false;

    for block in blocks {
        match block {
            ContentBlock::Rich(value) => output.push(ContentBlock::Rich(value.clone())),
            ContentBlock::Text { text } => {
                let points: Vec<char> = text.chars().collect();
                let block_start = consumed;
                let block_end = block_start + points.len();

                let head_end = removed_start
                    .saturating_sub(block_start)
                    .min(points.len());
                let tail_start = removed_end
                    .saturating_sub(block_start)
                    .min(points.len());
                let intersects_removed =
                    block_start < removed_end && block_end > removed_start;

                let mut retained = String::new();
                retained.extend(points[..head_end].iter());
                if intersects_removed && !marker_inserted {
                    retained.push_str(PRUNE_MARKER);
                    marker_inserted = true;
                }
                retained.extend(points[tail_start..].iter());

                if !retained.is_empty() {
                    output.push(ContentBlock::Text { text: retained });
                }
                consumed = block_end;
            }
        }
    }

    if !marker_inserted {
        return Err(PruneError::Invariant(
            "failed to locate removed text span".to_owned(),
        ));
    }

    let retained_chars = measure_content(&output);
    if retained_chars > config.threshold_chars {
        return Err(PruneError::Invariant(format!(
            "retained chars ({retained_chars}) exceed threshold ({})",
            config.threshold_chars
        )));
    }
    if retained_chars >= total_chars {
        return Err(PruneError::Invariant(
            "pruned content must be smaller than original".to_owned(),
        ));
    }

    Ok(Some(PrunedContent {
        content: output,
        provenance: PruneProvenance {
            policy_version: POLICY_VERSION,
            original_chars: total_chars,
            retained_chars,
            removed_chars: total_chars - retained_chars,
            marker_count: 1,
        },
    }))
}

/// Prunes a tool-result envelope without changing call pairing or the caller's
/// opaque recovery reference. This is the seam D2B will adapt to D1's SpillRef.
pub fn prune_tool_result<Rich: Clone, RecoveryRef: Clone>(
    result: &ToolResultEnvelope<Rich, RecoveryRef>,
    config: PruneConfig,
) -> Result<Option<PrunedToolResult<Rich, RecoveryRef>>, PruneError> {
    let Some(pruned) = prune_content(&result.content, config)? else {
        return Ok(None);
    };

    Ok(Some(PrunedToolResult {
        call_id: result.call_id.clone(),
        content: pruned.content,
        recovery_ref: result.recovery_ref.clone(),
        provenance: pruned.provenance,
    }))
}
