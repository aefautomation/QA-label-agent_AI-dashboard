// Writes label runs into the AEF AI Platform database.
//
// This is what replaces HTTP polling: the platform creates a label_runs row on
// upload, hands the id to the agent, and then polls its own database. The agent
// moves the row through running -> review (or failed) and writes the label model,
// the review items and the document artifacts.
//
// Document locations are stored as Storage *paths*; the platform signs them on
// demand so no expiring URL is ever persisted.
import { createClient } from '@supabase/supabase-js';

const RUN_TABLE = 'label_runs';
const ITEM_TABLE = 'label_review_items';
const ARTIFACT_TABLE = 'label_run_artifacts';
const EVENT_TABLE = 'label_run_events';

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export class LabelRunStore {
  constructor({ url, serviceRoleKey } = {}) {
    this.enabled = Boolean(url && serviceRoleKey);
    this.client = this.enabled
      ? createClient(url, serviceRoleKey, { auth: { persistSession: false } })
      : null;
  }

  /**
   * Resolves the row this run writes to: the id the platform handed over, or a
   * fresh row so email/Make-triggered runs also show up in the platform.
   */
  async ensureRun({ labelRunId, agentRunId, uploadedFileName, createdBy }) {
    if (!this.enabled) return null;

    if (labelRunId) {
      const { data, error } = await this.client
        .from(RUN_TABLE)
        .select('id')
        .eq('id', labelRunId)
        .maybeSingle();

      if (error) throw new Error(`Kon label_run ${labelRunId} niet lezen: ${error.message}`);
      if (data?.id) return data.id;

      console.warn(`label_run ${labelRunId} bestaat niet; er wordt een nieuwe rij aangemaakt.`);
    }

    const { data, error } = await this.client
      .from(RUN_TABLE)
      .insert({
        run_id: agentRunId,
        status: 'queued',
        uploaded_file_name: uploadedFileName || null,
        created_by: createdBy || null,
        review_required: true
      })
      .select('id')
      .single();

    if (error) throw new Error(`Kon label_run niet aanmaken: ${error.message}`);
    return data.id;
  }

  async markRunning({ runRowId, agentRunId }) {
    if (!this.enabled || !runRowId) return;

    const { error } = await this.client
      .from(RUN_TABLE)
      .update({
        status: 'running',
        run_id: agentRunId,
        status_message: null,
        error_message: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', runRowId);

    if (error) throw new Error(`Kon status "running" niet zetten: ${error.message}`);
  }

  async markFailed({ runRowId, message }) {
    if (!this.enabled || !runRowId) return;

    const { error } = await this.client
      .from(RUN_TABLE)
      .update({
        status: 'failed',
        error_message: String(message ?? 'Onbekende fout').slice(0, 2000),
        updated_at: new Date().toISOString()
      })
      .eq('id', runRowId);

    // Never let bookkeeping mask the original failure.
    if (error) console.error(`Kon status "failed" niet zetten: ${error.message}`);
  }

  /**
 * Finds the row for an agent run id.
 *
 * Finalizing happens long after the run — possibly days later, certainly after a
 * Railway restart — so the agent cannot look this up in its own memory.
 */
  async findRunByAgentRunId(agentRunId) {
    if (!this.enabled) return null;

    const { data, error } = await this.client
      .from(RUN_TABLE)
      .select('id, run_id, status, article_number, product_name')
      .eq('run_id', agentRunId)
      .maybeSingle();

    if (error) throw new Error(`Kon label_run ${agentRunId} niet lezen: ${error.message}`);
    return data ?? null;
  }

  /** Storage path of one artifact of a run, e.g. the uploaded specification. */
  async findArtifactPath({ runRowId, artifactType }) {
    if (!this.enabled || !runRowId) return null;

    const { data, error } = await this.client
      .from(ARTIFACT_TABLE)
      .select('path')
      .eq('label_run_id', runRowId)
      .eq('artifact_type', artifactType)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Kon artifact ${artifactType} niet lezen: ${error.message}`);
    return data?.path ?? null;
  }

  /**
   * Records the definitive document.
   *
   * Replaces an earlier final document rather than adding a second one, so a
   * re-finalized run does not leave two files that both claim to be definitive.
   */
  async writeFinalArtifact({ runRowId, path: objectPath, label, approvedBy, detail }) {
    if (!this.enabled || !runRowId) return;

    const { error: deleteError } = await this.client
      .from(ARTIFACT_TABLE)
      .delete()
      .eq('label_run_id', runRowId)
      .eq('artifact_type', 'final_docx');

    if (deleteError) {
      throw new Error(`Kon oud definitief label niet opruimen: ${deleteError.message}`);
    }

    const { error } = await this.client.from(ARTIFACT_TABLE).insert({
      label_run_id: runRowId,
      artifact_type: 'final_docx',
      label: label || 'Definitief label (Word)',
      path: objectPath,
      url: null
    });

    if (error) throw new Error(`Kon definitief label niet vastleggen: ${error.message}`);

    await this.recordEvent({
      runRowId,
      eventType: 'final_document_rendered',
      detail: { approvedBy: approvedBy || null, path: objectPath, ...(detail ?? {}) }
    });
  }

  async recordEvent({ runRowId, eventType, detail }) {
    if (!this.enabled || !runRowId) return;

    const { error } = await this.client.from(EVENT_TABLE).insert({
      label_run_id: runRowId,
      event_type: eventType,
      detail: detail ?? null
    });

    if (error) console.error(`Kon label_run_event niet schrijven: ${error.message}`);
  }

  /** Writes the finished run: label model, review items, artifacts, status review. */
  async writeResult({ runRowId, agentRunId, spec, platformModel, documents }) {
    if (!this.enabled || !runRowId) return null;

    const now = new Date().toISOString();
    const { labelModel, reviewItems, artifacts, previewHtml, previewText, emailReport } = platformModel;
    const reviewRequired = reviewItems.some((item) => item.required);

    const { error: runError } = await this.client
      .from(RUN_TABLE)
      .update({
        run_id: agentRunId,
        status: 'review',
        status_message: null,
        error_message: null,
        article_number: labelModel.articleNumber,
        product_name: labelModel.productName,
        review_required: reviewRequired,
        label_model: labelModel,
        // Kept for traceability: what the parser read out of the specification.
        extracted_data: {
          templateType: spec.templateType,
          isFrozen: spec.isFrozen,
          isFisheryProduct: spec.isFisheryProduct,
          supplierNumber: spec.supplierNumber,
          nutrition: spec.nutrition,
          logistics: spec.logistics,
          allergens: spec.allergens,
          additives: spec.additives,
          fish: spec.fish,
          storage: spec.storage,
          qaWarnings: spec.qaWarnings
        },
        preview_html: previewHtml,
        preview_text: previewText,
        email_report: emailReport,
        updated_at: now
      })
      .eq('id', runRowId);

    if (runError) throw new Error(`Kon label_run niet bijwerken: ${runError.message}`);

    // item_key is unique per run, so a re-run updates the proposals without
    // discarding QA decisions already made on them.
    const itemRows = reviewItems.map((item) => ({
      label_run_id: runRowId,
      item_key: item.itemKey,
      field_key: item.fieldKey,
      title: item.title,
      section: item.section,
      category: item.category,
      language_code: item.languageCode,
      source_text: item.sourceText,
      proposed_text: item.proposedText,
      confidence: item.confidence,
      color_status: item.colorStatus,
      confidence_source: item.source,
      required: item.required,
      message: item.message,
      group_key: item.groupKey ?? null,
      segments: item.segments ?? null,
      updated_at: now
    }));

    for (const batch of chunk(itemRows, 500)) {
      const { error } = await this.client
        .from(ITEM_TABLE)
        .upsert(batch, { onConflict: 'label_run_id,item_key' });

      if (error) throw new Error(`Kon reviewpunten niet schrijven: ${error.message}`);
    }

    const { error: deleteError } = await this.client
      .from(ARTIFACT_TABLE)
      .delete()
      .eq('label_run_id', runRowId);

    if (deleteError) throw new Error(`Kon oude artifacts niet opruimen: ${deleteError.message}`);

    if (artifacts.length > 0) {
      const { error } = await this.client.from(ARTIFACT_TABLE).insert(
        artifacts.map((artifact) => ({
          label_run_id: runRowId,
          artifact_type: artifact.artifactType,
          label: artifact.label,
          url: artifact.url || null,
          path: artifact.path || null
        }))
      );

      if (error) throw new Error(`Kon artifacts niet schrijven: ${error.message}`);
    }

    await this.recordEvent({
      runRowId,
      eventType: 'agent_result_written',
      detail: {
        agentRunId,
        backend: documents?.backend ?? null,
        fields: labelModel.fields.length,
        reviewItems: reviewItems.length,
        required: reviewItems.filter((item) => item.required).length,
        templateType: spec.templateType
      }
    });

    return { runRowId, reviewItems: reviewItems.length, reviewRequired };
  }
}
