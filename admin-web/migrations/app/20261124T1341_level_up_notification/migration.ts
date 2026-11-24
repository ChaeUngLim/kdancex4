#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/353ddc7e2ed5295000fc78153a53cbd81076a176794daa0cfa2586291e730b83/contract';
import startContract from '../../snapshots/353ddc7e2ed5295000fc78153a53cbd81076a176794daa0cfa2586291e730b83/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/e2782814b374013c9631c61a7fe9838d90f1b3db03eb0ac085ac8051a70484c3/contract';
import endContract from '../../snapshots/e2782814b374013c9631c61a7fe9838d90f1b3db03eb0ac085ac8051a70484c3/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      // S6-3.3(레벨 계산 작업) — 알림 종류 level_up(레벨이 올라 카드가 발급됨)을 회원 알림 값에 더한다(계약 14 §5-1). 칸은 늘지 않아 기존 행은 그대로 통과한다.
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_e5a5726e',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_8ac037d5',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'listing_suspended', 'business_restriction_lifted', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed', 'release_declined', 'absence_marked', 'absence_dispute_requested', 'absence_dispute_resolved', 'payment_deadline_soon', 'gender_imbalance', 'pre_class_reminder', 'inquiry_received', 'inquiry_answered', 'inquiry_overdue', 'report_received', 'report_filed', 'report_in_review', 'report_resolved', 'refund_completed', 'refund_account_reinput', 'level_up')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
