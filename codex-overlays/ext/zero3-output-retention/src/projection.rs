use codex_extension_api::ToolResultInput;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::ResponseInputItem;

use crate::GREP_SPILL_TOOL_NAME;
use crate::OutputRetentionConfig;
use crate::READ_SPILL_TOOL_NAME;
use crate::RetentionOutcome;
use crate::SpillSource;
use crate::SpillStore;
use crate::retain_text;

pub(crate) async fn project_tool_result(
    store: &dyn SpillStore,
    config: OutputRetentionConfig,
    input: ToolResultInput<'_>,
) -> Result<Option<ResponseInputItem>, String> {
    if input.tool_name.is_default_namespace()
        && matches!(
            input.tool_name.name.as_str(),
            READ_SPILL_TOOL_NAME | GREP_SPILL_TOOL_NAME
        )
    {
        return Ok(None);
    }

    let Some(complete_text) = input.complete_text else {
        return Ok(None);
    };
    let Some(current_text) = plain_model_text(input.model_response) else {
        // Mixed media and other structured result bodies remain untouched.
        return Ok(None);
    };
    if complete_text.len() <= current_text.len() && complete_text.len() <= config.max_inline_bytes {
        return Ok(None);
    }

    // Never inflate the existing Codex model-context budget. If Codex already
    // projected a smaller text body, the Zero3 preview must fit inside it.
    let effective_budget = config.max_inline_bytes.min(current_text.len());
    if effective_budget == 0 {
        return Ok(None);
    }

    let source = SpillSource {
        thread_id: input.thread_store.level_id().to_string(),
        turn_id: input.turn_id.to_string(),
        call_id: input.call_id.to_string(),
        tool_name: input.tool_name.to_string(),
    };
    let outcome = retain_text(store, &source, complete_text, effective_budget).await;
    let RetentionOutcome::Spilled { projection, .. } = outcome else {
        // Fail open to Codex's existing model projection. Storage failure never
        // changes tool success or replaces a usable result with an error.
        return Ok(None);
    };

    Ok(replace_plain_model_text(input.model_response, projection))
}

fn plain_model_text(response: &ResponseInputItem) -> Option<&str> {
    match response {
        ResponseInputItem::FunctionCallOutput { output, .. }
        | ResponseInputItem::CustomToolCallOutput { output, .. } => match &output.body {
            FunctionCallOutputBody::Text(text) => Some(text.as_str()),
            FunctionCallOutputBody::ContentItems(_) => None,
        },
        _ => None,
    }
}

fn replace_plain_model_text(
    response: &ResponseInputItem,
    projection: String,
) -> Option<ResponseInputItem> {
    match response {
        ResponseInputItem::FunctionCallOutput { call_id, output } => {
            let mut output = output.clone();
            if !matches!(output.body, FunctionCallOutputBody::Text(_)) {
                return None;
            }
            output.body = FunctionCallOutputBody::Text(projection);
            Some(ResponseInputItem::FunctionCallOutput {
                call_id: call_id.clone(),
                output,
            })
        }
        ResponseInputItem::CustomToolCallOutput {
            call_id,
            name,
            output,
        } => {
            let mut output = output.clone();
            if !matches!(output.body, FunctionCallOutputBody::Text(_)) {
                return None;
            }
            output.body = FunctionCallOutputBody::Text(projection);
            Some(ResponseInputItem::CustomToolCallOutput {
                call_id: call_id.clone(),
                name: name.clone(),
                output,
            })
        }
        _ => None,
    }
}
