// Convert completed command results into process-ready stdout/stderr strings.
import { compactReport, ndjsonReport } from '../compact-output.mjs';
import { formatOmitEndDiagnostics } from '../omit-end-diagnostics.mjs';
import { formatTemplateDiagnostics } from '../template-diagnostics.mjs';
import { renderTemplateLines } from '../template.mjs';
import {
  formatDoctorTextOutput,
  formatInitTextOutput,
  formatExplainTextOutput,
  formatDemoTextOutput,
  formatListTextOutput,
  formatStatusTextOutput,
  formatWatchTextOutput,
  formatReadTextOutput,
  formatCompactTextOutput,
  formatCursorSetTextOutput,
  formatResetTextOutput,
  formatTextOutput,
  formatOutpostWarnings,
} from '../text-output.mjs';
function renderCommandResult(result, argv, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const format = result.format ?? 'json';

  if (format === 'template') {
    let output = '';
    try {
      output = result.template
        ? renderTemplateLines(result.template, result.templateDeltas ?? result.report?.deltas ?? [])
        : '';
    } catch (err) {
      return {
        ...result,
        code: 2,
        output: '',
        stderr: formatTemplateDiagnostics(
          { error: String(err.message ?? err), kind: 'config', hint: 'Fix the template.' },
          [],
        ),
      };
    }
    return {
      ...result,
      output,
      stderr: formatTemplateDiagnostics(result.report, result.warnings ?? []),
    };
  }

  if (format === 'schema') {
    return { ...result, output: `${JSON.stringify(result.report, null, 2)}\n`, stderr: '' };
  }

  if (format === 'compact') {
    const report = compactReport(result.report, result.code, result.warnings ?? [], {
      detail: argv.includes('--detail'),
      full: argv.includes('--full'),
    });
    return {
      ...result,
      output: `${JSON.stringify(report, null, 2)}\n`,
      stderr: deps.onProgress ? '' : (result.progress ?? ''),
    };
  }

  if (format === 'ndjson') {
    const output = ndjsonReport(result.report, result.code, result.warnings ?? [], {
      detail: argv.includes('--detail'),
      full: argv.includes('--full'),
      omitEnd: result.omitEnd === true,
    });
    return {
      ...result,
      output,
      stderr:
        result.omitEnd === true
          ? formatOmitEndDiagnostics(result.report, result.warnings ?? [])
          : deps.onProgress
            ? ''
            : (result.progress ?? ''),
    };
  }

  if (format === 'text') {
    const body =
      result.report?.command === 'doctor'
        ? formatDoctorTextOutput({ report: result.report })
        : result.report?.command === 'init'
          ? formatInitTextOutput({ report: result.report })
          : result.report?.command === 'explain'
            ? formatExplainTextOutput({ report: result.report })
            : result.report?.command === 'demo'
              ? formatDemoTextOutput({ report: result.report })
              : result.report?.command === 'list'
                ? formatListTextOutput({ report: result.report })
                : result.report?.command === 'status'
                  ? formatStatusTextOutput({ report: result.report, now })
                  : result.report?.command?.startsWith('watch ')
                    ? formatWatchTextOutput({ report: result.report })
                    : result.report?.command === 'read'
                      ? formatReadTextOutput({ code: result.code, report: result.report, now })
                      : result.report?.command === 'log compact'
                        ? formatCompactTextOutput({ report: result.report, now })
                        : result.report?.command === 'cursor set'
                          ? formatCursorSetTextOutput({ report: result.report, now })
                          : result.report?.command === 'reset'
                            ? formatResetTextOutput({ report: result.report, now })
                            : formatTextOutput({ code: result.code, report: result.report, now });
    return {
      ...result,
      output: `${body}${formatOutpostWarnings(result.warnings)}\n`,
      stderr: deps.onProgress ? '' : (result.progress ?? ''),
    };
  }

  const report =
    typeof result.report === 'string' || !result.warnings?.length
      ? result.report
      : { ...result.report, warnings: result.warnings };
  return {
    ...result,
    output: typeof report === 'string' ? report : `${JSON.stringify(report, null, 2)}\n`,
    stderr: deps.onProgress ? '' : (result.progress ?? ''),
  };
}

export { renderCommandResult };
