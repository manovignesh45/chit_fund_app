import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserId } from '../../../../lib/auth';
import { buildItrReport, ITR_SCOPES, type ItrScope } from '../../../../lib/itrReport';
import {
  clampRangeToAsOf, filingYearLabel, fiscalPeriodRange, fiscalYearLabel, fiscalYearOf, listFiscalYears,
  parseFiscalPeriod, parseFiscalYear, type FiscalPeriodKey,
} from '../../../../lib/fiscalPeriods';
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

    const fyParam = params.get('fy');
    const fy = fyParam === null || fyParam === '' ? fiscalYearOf(asOf) : parseFiscalYear(fyParam);
    if (fy === null) return bad('fy must be the start year of a fiscal year, e.g. 2025 for FY 2025-26.');

    const periodParam = params.get('period');
    const period: FiscalPeriodKey | null = periodParam === null || periodParam === '' ? 'FY' : parseFiscalPeriod(periodParam);
    if (period === null) return bad('period must be one of FY, H1, H2, Q1, Q2, Q3, Q4.');

    const scopeParam = (params.get('scope') ?? '').trim().toLowerCase();
    const scope: ItrScope | null = scopeParam === '' ? 'all' : (ITR_SCOPES as readonly string[]).includes(scopeParam) ? (scopeParam as ItrScope) : null;
    if (scope === null) return bad('scope must be one of all, chits, loans.');

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
