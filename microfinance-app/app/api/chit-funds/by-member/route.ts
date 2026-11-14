import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../lib/prisma';
import { getCurrentUserId } from '../../../../lib/auth';

// GET /api/chit-funds/by-member?globalMemberId=123
export async function GET(request: NextRequest) {
  try {
    const currentUserId = await getCurrentUserId(request);
    if (!currentUserId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const globalMemberId = parseInt(searchParams.get('globalMemberId') || '');
    if (!Number.isFinite(globalMemberId)) {
      return NextResponse.json({ error: 'globalMemberId is required' }, { status: 400 });
    }
    // Find all Member records for this global member (only this account's members and chit funds)
    const members = await prisma.member.findMany({
      where: {
        globalMemberId,
        globalMember: { createdById: currentUserId },
        chitFund: { createdById: currentUserId },
      },
      select: { chitFundId: true },
    });
    const chitFundIds = [...new Set(members.map(m => m.chitFundId))];
    if (chitFundIds.length === 0) {
      return NextResponse.json({ chitFunds: [] });
    }
    // Get chit fund details
    const chitFunds = await prisma.chitFund.findMany({
      where: { id: { in: chitFundIds }, createdById: currentUserId },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json({ chitFunds });
  } catch (error) {
    console.error('Error fetching chit funds by member:', error);
    return NextResponse.json({ error: 'Failed to fetch chit funds' }, { status: 500 });
  }
}
