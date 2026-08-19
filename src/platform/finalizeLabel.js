// Renders the definitive Word label from the values QA approved in the platform.

/**
 * Until now the only Word document was the one made during the run, before any
 * review — stored, correctly, as `draft_docx` / "Concept-label". Nothing ever
 * produced a `final_docx`, so the document QA ended up with never contained the
 * corrections QA had just made.
 *
 * This closes that gap. The platform posts the approved label model, and the
 * agent rebuilds the document from it with the same template as always, so the
 * Word layout stays owned by one place.
 *
 * Nothing is read from the agent's memory. The run may be finalized days later,
 * and Railway restarts on every deploy, so the specification is fetched back out
 * of Storage and parsed again. That makes finalizing work at any point after the
 * run instead of only while the container happens to be alive.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { hasSupabaseConfig } from '../config.js';
import { fillDocxTemplate } from '../docx/docxTemplate.js';
import { parseSpecification } from '../excel/specParser.js';
import {
  DOCUMENT_BUCKET,
  SupabaseStorageClient,
  documentObjectName
} from '../storage/supabaseStorage.js';
import { safeFilePart } from '../utils/normalize.js';
import { buildApprovedInputs } from './approvedInputs.js';
import { LabelRunStore } from './labelRunStore.js';

export class FinalizeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'FinalizeError';
    this.status = status;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function finalizeLabelDocument({ agentRunId, labelModel, approvedBy, config }) {
  if (!agentRunId) throw new FinalizeError('Geen runId meegegeven.');
  if (!labelModel || !Array.isArray(labelModel.fields)) {
    throw new FinalizeError('Geen labelModel met velden meegegeven.');
  }
  if (!hasSupabaseConfig(config)) {
    throw new FinalizeError(
      'Supabase is niet geconfigureerd; het definitieve label kan niet worden opgeslagen.',
      503
    );
  }

  const store = new LabelRunStore(config.supabase);
  const storageClient = new SupabaseStorageClient(config.supabase);

  const run = await store.findRunByAgentRunId(agentRunId);
  if (!run) throw new FinalizeError(`Run ${agentRunId} niet gevonden.`, 404);

  const specObject = await store.findArtifactPath({
    runRowId: run.id,
    artifactType: 'source_spec'
  });
  if (!specObject) {
    throw new FinalizeError(
      `Voor run ${agentRunId} is geen opgeslagen specificatie gevonden; het definitieve label kan niet opnieuw worden opgebouwd.`,
      409
    );
  }

  const workDir = path.join(config.tmpRoot, 'finalize', agentRunId);
  await fs.mkdir(workDir, { recursive: true });

  try {
    const localSpec = path.join(workDir, path.basename(specObject) || 'specificatie.xlsx');
    await storageClient.downloadToFile(DOCUMENT_BUCKET, specObject, localSpec);

    const spec = parseSpecification(localSpec);
    const { translations, applied } = buildApprovedInputs({ spec, labelModel });

    const templatePath = path.join(workDir, `template-${spec.templateType}.docx`);
    await storageClient.downloadTemplate(spec.templateType, templatePath);

    const fileName = `${safeFilePart(spec.articleNumber)}-${safeFilePart(
      spec.legalProduct || spec.description
    )}-${agentRunId}-definitief.docx`;
    const outputPath = path.join(workDir, fileName);

    await fillDocxTemplate({ templatePath, outputPath, spec, translations });

    const objectName = documentObjectName({
      kind: 'output',
      day: today(),
      runId: agentRunId,
      fileName
    });
    await storageClient.uploadLabel(outputPath, objectName);

    await store.writeFinalArtifact({
      runRowId: run.id,
      path: objectName,
      label: 'Definitief label (Word)',
      approvedBy,
      detail: {
        templateType: spec.templateType,
        fields: labelModel.fields.length,
        applied
      }
    });

    return {
      status: 'finalized',
      runId: agentRunId,
      fileName,
      // A path, not a URL: an expiring link must never be persisted, so the
      // platform signs this on demand like every other artifact.
      path: objectName,
      templateType: spec.templateType,
      applied
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
