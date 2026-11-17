import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserId } from '../../../../lib/auth';
import { buildItrReport } from '../../../../lib/itrReport';
import { clampRangeToAsOf, filingYearLabel, fiscalPeriodRange, fiscalYearLabel, fiscalYearOf, listFiscalYears } from '../../../../lib/fiscalPeriods';
import { parseItrReportQuery } from '../../../../lib/itrReportParams';
import { countUnclassifiedEntries, loadEarliestRecordDate, loadItrReportInput } from '../../../../lib/itrReportData';
import { findItrLine, parseItrLineSection, toItrReportView, type ItrLineResponse, type ItrReportResponse } from '../../../../lib/itrReportView';

/**
 * Tax report (profit & loss, cash flow, partner share) for one fiscal period.
 *
 * GET /api/reports/itr?fy=2025&period=FY|H1|H2|Q1|Q2|Q3|Q4&scope=all|chits|loans
 *   Defaults: the current fiscal year, FY, all. 400 on a bad value, 401 without a session.
 *   → ItrReportResponse: the report without its records (each line has `recordCount`), the
 *     fiscal years that have records (newest first) and the number of Record Amount entries
 *     still to classify.
 * GET …&section=pl|cash|warning&line=<key>
 *   → ItrLineResponse: the records behind one line of that same report (404 if no such line).
 *
 * Read-only; every row belongs to the data owner (getCurrentUserId).
 */

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function GET(request: NextRequest) {
  try {
    const ownerId = await getCurrentUserId(request);
    if (!ownerId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const params = new URL(request.url).searchParams;
    const asOf = new Date();

    const parsed = parseItrReportQuery(params, asOf);
    if (parsed.error !== null) return bad(parsed.error);
    const { fy, period, scope } = parsed.query;

    const sectionParam = params.get('section');
    const lineKey = params.get('line');
    const wantsLine = sectionParam !== null || lineKey !== null;
    const section = wantsLine ? parseItrLineSection(sectionParam) : null;
    if (wantsLine && (section === null || !lineKey)) return bad('A line read needs section (pl, cash or warning) and line.');

    const range = clampRangeToAsOf(fiscalPeriodRange(fy, period), asOf);
    const input = await loadItrReportInput(ownerId, { scope, start: range.start, endExclusive: range.endExclusive });
    const report = buildItrReport(input, { fy, period, scope, asOf });

    if (wantsLine) {
      const line = findItrLine(report, section!, lineKey!);
      if (!line) return NextResponse.json({ error: 'This report has no such line.' }, { status: 404 });
      return NextResponse.json({ line } satisfies ItrLineResponse);
    }

    const [earliest, unclassifiedCount] = await Promise.all([loadEarliestRecordDate(ownerId), countUnclassifiedEntries(ownerId)]);
    const current = fiscalYearOf(asOf);
    const fiscalYears = listFiscalYears(earliest, asOf)
      .reverse()
      .map((year) => ({ fy: year, label: fiscalYearLabel(year), filingYearLabel: filingYearLabel(year), running: year === current }));

    return NextResponse.json({ report: toItrReportView(report), fiscalYears, unclassifiedCount } satisfies ItrReportResponse);
  } catch (error) {
    console.error('Error building the tax report:', error);
    return NextResponse.json({ error: 'Failed to build the tax report' }, { status: 500 });
  }
}
