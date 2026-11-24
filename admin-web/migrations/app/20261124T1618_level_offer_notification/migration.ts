#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/2df1a9aa9c81500bc1f9db0dfe7da5fc3f861d0691e1872bffac8444eabf6cc7/contract';
import endContract from '../../snapshots/2df1a9aa9c81500bc1f9db0dfe7da5fc3f861d0691e1872bffac8444eabf6cc7/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/e2782814b374013c9631c61a7fe9838d90f1b3db03eb0ac085ac8051a70484c3/contract';
import startContract from '../../snapshots/e2782814b374013c9631c61a7fe9838d90f1b3db03eb0ac085ac8051a70484c3/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      // S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — 알림 종류 level_offer(강사가 올려 준 레벨 승급 안내)를 회원 알림 값에 더한다(계약 14 §6-1). 칸은 늘지 않아 기존 행은 그대로 통과한다.
      this.dropCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_8ac037d5',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'notifications',
        constraint: 'notifications_kind_check_1c915e03',
        expression: sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due', 'share_rate_changed', 'affiliation_requested', 'affiliation_approved', 'affiliation_rejected', 'delegation_changed', 'staff_notice_published', 'merchant_application_approved', 'merchant_application_rejected', 'payout_account_changed', 'terms_change_notice', 'restriction_notice', 'listing_suspended', 'business_restriction_lifted', 'release_completed', 'release_requested', 'class_submitted', 'class_approved', 'class_revision_requested', 'class_approval_reminder', 'session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed', 'substitute_requested', 'substitute_accepted', 'substitute_confirmed', 'instructor_changed', 'class_announcement', 'substitute_assigned', 'private_lesson_booked', 'private_lesson_cancelled', 'class_edit_requested', 'class_edit_approved', 'class_edit_rejected', 'class_changed', 'release_declined', 'absence_marked', 'absence_dispute_requested', 'absence_dispute_resolved', 'payment_deadline_soon', 'gender_imbalance', 'pre_class_reminder', 'inquiry_received', 'inquiry_answered', 'inquiry_overdue', 'report_received', 'report_filed', 'report_in_review', 'report_resolved', 'refund_completed', 'refund_account_reinput', 'level_up', 'level_offer')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
