import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserId } from '../../../../../lib/auth';
import { buildItrReport } from '../../../../../lib/itrReport';
import { clampRangeToAsOf, fiscalPeriodRange } from '../../../../../lib/fiscalPeriods';
import { countUnclassifiedEntries, loadItrReportInput } from '../../../../../lib/itrReportData';
import { parseItrReportQuery } from '../../../../../lib/itrReportParams';
import { buildItrReportXlsx, itrExportFileName, XLSX_CONTENT_TYPE } from '../../../../../lib/itrReportExcel';

/**
 * Tax report as an Excel workbook, for the accountant.
 *
 * GET /api/reports/itr/export?fy=2025&period=FY|H1|H2|Q1|Q2|Q3|Q4&scope=all|chits|loans
 *   Same parameters, defaults and errors as GET /api/reports/itr (400 on a bad value, 401
 *   without a session). Built from the same buildItrReport result as the page, so the file
 *   equals the screen. File name: tax-report-FY2025-26[-Q1]-all[-to-YYYY-MM-DD].xlsx.
 *
 * Read-only; every row belongs to the data owner (getCurrentUserId).
 */
export async function GET(request: NextRequest) {
  try {
    const ownerId = await getCurrentUserId(request);
    if (!ownerId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const asOf = new Date();
    const parsed = parseItrReportQuery(new URL(request.url).searchParams, asOf);
    if (parsed.error !== null) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { fy, period, scope } = parsed.query;

    const range = clampRangeToAsOf(fiscalPeriodRange(fy, period), asOf);
    const [input, unclassifiedCount] = await Promise.all([
      loadItrReportInput(ownerId, { scope, start: range.start, endExclusive: range.endExclusive }),
      countUnclassifiedEntries(ownerId),
    ]);
    const report = buildItrReport(input, { fy, period, scope, asOf });
    const buffer = await buildItrReportXlsx(report, { generatedAt: asOf, unclassifiedCount, partners: input.partners });
    const filename = itrExportFileName(report);

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': XLSX_CONTENT_TYPE,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Error exporting the tax report:', error);
    return NextResponse.json({ error: 'Failed to export the tax report' }, { status: 500 });
  }
}
