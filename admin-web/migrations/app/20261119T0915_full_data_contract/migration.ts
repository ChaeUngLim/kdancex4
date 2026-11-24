#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/ebe0257ccf34be1d63b750729332541790a4acc248f759f6ef31e1aa7b65c250/contract';
import endContract from '../../snapshots/ebe0257ccf34be1d63b750729332541790a4acc248f759f6ef31e1aa7b65c250/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
  sql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'academies',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('name', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('owner_member_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('refund_policy_tiers', 'json', {
            notNull: true,
            default: fn(sql`'[]'::jsonb`),
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('region_gu', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('region_sido', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'calendar_entries',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('ends_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('reservation_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('session_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('starts_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'class_offerings',
        columns: [
          col('class_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('enrollment_unit', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('first_session_starts_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('label', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('last_session_ends_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('price_amount', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_class_offerings_period_order_e0749d71',
            sql`last_session_ends_at > first_session_starts_at`,
          ),
          checkExpression('ck_class_offerings_price_nonneg_dd3d974f', sql`price_amount >= 0`),
          checkExpression(
            'class_offerings_enrollment_unit_check_6417069e',
            sql`"enrollment_unit" IN ('term', 'session')`,
          ),
          checkExpression(
            'class_offerings_status_check_6f620795',
            sql`"status" IN ('open', 'closed')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'class_sessions',
        columns: [
          col('ends_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('offering_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('seq', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('starts_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_class_sessions_time_order_30314b5b', sql`ends_at > starts_at`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'classes',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('class_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('genre', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('instructor_name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('seat_mode', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'classes_class_kind_check_a7e6290f',
            sql`"class_kind" IN ('regular', 'private_lesson', 'basic', 'lady_style', 'one_day', 'event', 'party', 'performance', 'competition')`,
          ),
          checkExpression(
            'classes_genre_check_8c40f47e',
            sql`"genre" IN ('dance_sport', 'argentine_tango', 'swing', 'salsa_bachata')`,
          ),
          checkExpression(
            'classes_seat_mode_check_5cad1fdc',
            sql`"seat_mode" IN ('gender_split', 'single')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'member_interest_genres',
        columns: [
          col('genre', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['member_id', 'genre']),
          checkExpression(
            'member_interest_genres_genre_check_8c40f47e',
            sql`"genre" IN ('dance_sport', 'argentine_tango', 'swing', 'salsa_bachata')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'member_regions',
        columns: [
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('region_gu', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('region_sido', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['member_id', 'region_sido', 'region_gu'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'members',
        columns: [
          col('auth_user_id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('available_from', 'time', { codecRef: { codecId: 'pg/time-string@1' } }),
          col('available_to', 'time', { codecRef: { codecId: 'pg/time-string@1' } }),
          col('base_genre', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('birth_date', 'date', { notNull: true, codecRef: { codecId: 'pg/date-string@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('experience_level', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('gender', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('identity_ci_hash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('phone', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('signup_notice_ack_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_members_available_window_e7d545c5',
            sql`(available_from IS NULL AND available_to IS NULL) OR (available_from IS NOT NULL AND available_to IS NOT NULL AND available_from < available_to)`,
          ),
          checkExpression(
            'members_base_genre_check_93719b87',
            sql`"base_genre" IN ('dance_sport', 'argentine_tango', 'swing', 'salsa_bachata')`,
          ),
          checkExpression(
            'members_experience_level_check_de47a25e',
            sql`"experience_level" IN ('entry', 'beginner', 'novice_intermediate', 'intermediate', 'advanced', 'dancer')`,
          ),
          checkExpression('members_gender_check_6679dc61', sql`"gender" IN ('male', 'female')`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'notifications',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('delivery_status', 'text', {
            notNull: true,
            default: lit('pending'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('order_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('payload', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
          col('read_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('recipient_member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('reservation_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'notifications_delivery_status_check_7ddc7be2',
            sql`"delivery_status" IN ('pending', 'sent', 'skipped')`,
          ),
          checkExpression(
            'notifications_kind_check_32f259be',
            sql`"kind" IN ('payment_confirmed_member', 'payment_confirmed_owner', 'reservation_cancelled', 'refund_pending', 'refund_failed', 'payment_refund_due')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'order_events',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('from_status', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('order_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('reason', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('to_status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'order_events_from_status_check_6ffb1f51',
            sql`"from_status" IN ('pending', 'paid', 'expired', 'cancelled', 'partially_refunded', 'refunded')`,
          ),
          checkExpression(
            'order_events_to_status_check_09c9e388',
            sql`"to_status" IN ('pending', 'paid', 'expired', 'cancelled', 'partially_refunded', 'refunded')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'orders',
        columns: [
          col('benefit_discount_amount', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('booking_fee_amount', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('cancel_fee_platform_share_bp', 'int4', {
            notNull: true,
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('closed_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('coupon_discount_amount', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotency_key', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('intermediary_notice_version', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('list_price_amount', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('member_terms_version', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('merchant_terms_version', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('offering_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('paid_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('platform_fee_rate_bp', 'int4', {
            notNull: true,
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('price_breakdown', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
          col('refund_notice_version_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('total_amount', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_orders_benefit_discount_nonneg_2771c8f7',
            sql`benefit_discount_amount >= 0`,
          ),
          checkExpression('ck_orders_booking_fee_nonneg_a58f0f37', sql`booking_fee_amount >= 0`),
          checkExpression(
            'ck_orders_coupon_discount_nonneg_37155932',
            sql`coupon_discount_amount >= 0`,
          ),
          checkExpression(
            'ck_orders_fee_rates_b46d0620',
            sql`platform_fee_rate_bp BETWEEN 0 AND 10000 AND cancel_fee_platform_share_bp BETWEEN 0 AND 10000`,
          ),
          checkExpression('ck_orders_list_price_nonneg_6070b00a', sql`list_price_amount >= 0`),
          checkExpression('ck_orders_total_amount_b70a6922', sql`total_amount >= 0`),
          checkExpression(
            'ck_orders_total_formula_8685d44f',
            sql`total_amount = GREATEST(0, list_price_amount - benefit_discount_amount - coupon_discount_amount) + booking_fee_amount`,
          ),
          checkExpression(
            'orders_status_check_14217358',
            sql`"status" IN ('pending', 'paid', 'expired', 'cancelled', 'partially_refunded', 'refunded')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'payment_exceptions',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('order_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('payment_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('pg_transaction_id', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('received_amount', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_payment_exceptions_received_nonneg_164294de',
            sql`received_amount >= 0`,
          ),
          checkExpression(
            'payment_exceptions_kind_check_79e30c44',
            sql`"kind" IN ('amount_mismatch', 'deposit_on_closed_order')`,
          ),
          checkExpression(
            'payment_exceptions_status_check_81b4bac5',
            sql`"status" IN ('refund_due')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'payment_webhook_events',
        columns: [
          col('event_type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('gateway_payment_id', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('payload', 'json', { notNull: true, codecRef: { codecId: 'pg/json@1' } }),
          col('received_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('result', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('webhook_id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'payment_webhook_events_result_check_409bc0e1',
            sql`"result" IN ('confirmed', 'duplicate', 'rejected_signature', 'amount_mismatch', 'deposit_on_closed_order', 'ignored')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'payments',
        columns: [
          col('amount', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('due_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('gateway_payment_id', 'character varying(64)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 64 } },
          }),
          col('gateway_payment_key', 'character varying(200)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('method', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('order_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('paid_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('pg_reported_amount', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('virtual_account_bank_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('virtual_account_holder', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('virtual_account_number', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_payments_amount_2ce36fec', sql`amount >= 0`),
          checkExpression(
            'payments_method_check_44c1627e',
            sql`"method" IN ('virtual_account', 'card', 'easy_transfer', 'easy_pay')`,
          ),
          checkExpression(
            'payments_status_check_cd959a31',
            sql`"status" IN ('ready', 'paid', 'expired', 'cancelled')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'refund_events',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('event_type', 'character varying(50)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 50 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('payload', 'json', {
            notNull: true,
            default: fn(sql`'{}'::jsonb`),
            codecRef: { codecId: 'pg/json@1' },
          }),
          col('refund_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'refund_notice_versions',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('version', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_refund_notice_versions_version_positive_c2490804', sql`version >= 1`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'refunds',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('failure_code', 'character varying(100)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('failure_message', 'character varying(500)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 500 } },
          }),
          col('gateway_refund_id', 'character varying(200)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotency_key', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('payment_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('reason', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('refund_account_bank_code', 'character varying(20)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 20 } },
          }),
          col('refund_account_holder_name', 'character varying(100)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('refund_account_number', 'character varying(64)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 64 } },
          }),
          col('refund_rate_bp', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('refunded_amount', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('requested_amount', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('reservation_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_refunds_amount_order_c8243d0c',
            sql`refunded_amount <= requested_amount`,
          ),
          checkExpression(
            'ck_refunds_refund_rate_bp_ca6c50f3',
            sql`refund_rate_bp >= 0 AND refund_rate_bp <= 10000`,
          ),
          checkExpression('ck_refunds_refunded_amount_6a46e61e', sql`refunded_amount >= 0`),
          checkExpression('ck_refunds_requested_amount_2b82a455', sql`requested_amount >= 0`),
          checkExpression('refunds_reason_check_5dc0722f', sql`"reason" IN ('member_request')`),
          checkExpression(
            'refunds_status_check_552006ca',
            sql`"status" IN ('succeeded', 'pending', 'failed')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'reservations',
        columns: [
          col('cancel_reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('cancelled_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('offering_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('order_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('seat_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('seat_pool_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_reservations_cancel_reason_a4990f93',
            sql`cancel_reason IS NULL OR status = 'cancelled'`,
          ),
          checkExpression(
            'reservations_cancel_reason_check_6a45d718',
            sql`"cancel_reason" IN ('member_request', 'self_cancel_unpaid')`,
          ),
          checkExpression(
            'reservations_seat_kind_check_e8a9b80c',
            sql`"seat_kind" IN ('male', 'female', 'any')`,
          ),
          checkExpression(
            'reservations_status_check_e35f8895',
            sql`"status" IN ('held', 'confirmed', 'cancelled', 'expired')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'seat_pools',
        columns: [
          col('capacity', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('confirmed_count', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('held_count', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('offering_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('seat_kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_seat_pools_capacity_positive_2e07dccc', sql`capacity > 0`),
          checkExpression('ck_seat_pools_confirmed_nonneg_7a415495', sql`confirmed_count >= 0`),
          checkExpression('ck_seat_pools_held_nonneg_5ddbd710', sql`held_count >= 0`),
          checkExpression(
            'ck_seat_pools_not_over_095b8bdc',
            sql`held_count + confirmed_count <= capacity`,
          ),
          checkExpression(
            'seat_pools_seat_kind_check_e8a9b80c',
            sql`"seat_kind" IN ('male', 'female', 'any')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'settlement_entries',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('amount', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('order_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_settlement_entries_amount_nonneg_2ce36fec', sql`amount >= 0`),
          checkExpression(
            'settlement_entries_kind_check_2709fae1',
            sql`"kind" IN ('payment_hold')`,
          ),
          checkExpression('settlement_entries_status_check_ed281314', sql`"status" IN ('hold')`),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academies',
        index: 'academies_owner_member_id_idx_66b834ed',
        columns: ['owner_member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academies',
        index: 'ix_academies_region_77fa7e95',
        columns: ['region_sido', 'region_gu'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'calendar_entries',
        index: 'calendar_entries_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'calendar_entries',
        index: 'calendar_entries_reservation_id_idx_919eec76',
        columns: ['reservation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'calendar_entries',
        index: 'calendar_entries_session_id_idx_00ba47bf',
        columns: ['session_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'calendar_entries',
        index: 'ix_calendar_member_start_ba97dbb1',
        columns: ['member_id', 'starts_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'calendar_entries',
        index: 'uq_calendar_member_session_09f9300d',
        columns: ['member_id', 'session_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_offerings',
        index: 'ix_offerings_class_id_0031a3d7',
        columns: ['class_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_offerings',
        index: 'ix_offerings_start_28f7c3ad',
        columns: ['status', 'first_session_starts_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_sessions',
        index: 'ix_sessions_offering_id_47c4ad39',
        columns: ['offering_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'class_sessions',
        index: 'uq_sessions_offering_seq_d998b903',
        columns: ['offering_id', 'seq'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'ix_classes_academy_id_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'classes',
        index: 'ix_classes_genre_cbd1c3fd',
        columns: ['genre'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'member_interest_genres',
        index: 'member_interest_genres_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'member_regions',
        index: 'member_regions_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'members',
        index: 'uq_members_auth_user_id_7c05eb2e',
        columns: ['auth_user_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'members',
        index: 'uq_members_identity_ci_hash_b7d3866c',
        columns: ['identity_ci_hash'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'ix_notifications_recipient_created_3cc410c0',
        columns: ['recipient_member_id', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_order_id_idx_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_recipient_member_id_idx_85f41f39',
        columns: ['recipient_member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_reservation_id_idx_919eec76',
        columns: ['reservation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'uq_notifications_kind_order_recipient_a0ba927b',
        columns: ['kind', 'order_id', 'recipient_member_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'order_events',
        index: 'ix_order_events_order_id_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orders',
        index: 'ix_orders_member_id_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orders',
        index: 'orders_offering_id_idx_47c4ad39',
        columns: ['offering_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orders',
        index: 'orders_refund_notice_version_id_idx_33f0477c',
        columns: ['refund_notice_version_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'orders',
        index: 'uq_orders_member_idempotency_c19dc27d',
        columns: ['member_id', 'idempotency_key'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'payment_exceptions',
        index: 'payment_exceptions_order_id_idx_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'payment_exceptions',
        index: 'payment_exceptions_payment_id_idx_7931cf41',
        columns: ['payment_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'payment_exceptions',
        index: 'uq_payment_exceptions_payment_kind_d828a986',
        columns: ['payment_id', 'kind'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'payment_webhook_events',
        index: 'uq_webhook_events_webhook_id_f872ce33',
        columns: ['webhook_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'payments',
        index: 'ix_payments_order_id_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'payments',
        index: 'ix_payments_status_due_4934f71d',
        columns: ['status', 'due_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'payments',
        index: 'uq_payments_gateway_payment_id_3dbc865d',
        columns: ['gateway_payment_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'payments',
        index: 'uq_payments_order_live_b9c8378f',
        columns: ['order_id'],
        extras: { where: sql`(status IN ('ready', 'paid'))`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_events',
        index: 'ix_refund_events_refund_id_a955faff',
        columns: ['refund_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_notice_versions',
        index: 'refund_notice_versions_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refund_notice_versions',
        index: 'uq_refund_notice_academy_version_d4c7060f',
        columns: ['academy_id', 'version'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'ix_refunds_payment_id_7931cf41',
        columns: ['payment_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'refunds_reservation_id_idx_919eec76',
        columns: ['reservation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'uq_refunds_idempotency_key_5402f2f2',
        columns: ['idempotency_key'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'refunds',
        index: 'uq_refunds_reservation_id_active_404b463a',
        columns: ['reservation_id'],
        extras: { where: sql`(status <> 'failed')`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'reservations',
        index: 'ix_reservations_member_id_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reservations',
        index: 'ix_reservations_offering_id_47c4ad39',
        columns: ['offering_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reservations',
        index: 'ix_reservations_order_id_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reservations',
        index: 'reservations_seat_pool_id_idx_0b0704d3',
        columns: ['seat_pool_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reservations',
        index: 'uq_reservations_member_offering_active_c0470a89',
        columns: ['member_id', 'offering_id'],
        extras: { where: sql`(status IN ('held', 'confirmed'))`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'seat_pools',
        index: 'seat_pools_offering_id_idx_47c4ad39',
        columns: ['offering_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'seat_pools',
        index: 'uq_seat_pools_offering_kind_5a6035c9',
        columns: ['offering_id', 'seat_kind'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'settlement_entries',
        index: 'settlement_entries_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'settlement_entries',
        index: 'settlement_entries_order_id_idx_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'settlement_entries',
        index: 'uq_settlement_order_kind_284c0463',
        columns: ['order_id', 'kind'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academies',
        foreignKey: {
          name: 'academies_owner_member_id_fkey',
          columns: ['owner_member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'calendar_entries',
        foreignKey: {
          name: 'calendar_entries_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'calendar_entries',
        foreignKey: {
          name: 'calendar_entries_reservation_id_fkey',
          columns: ['reservation_id'],
          references: { schema: 'public', table: 'reservations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'calendar_entries',
        foreignKey: {
          name: 'calendar_entries_session_id_fkey',
          columns: ['session_id'],
          references: { schema: 'public', table: 'class_sessions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_offerings',
        foreignKey: {
          name: 'class_offerings_class_id_fkey',
          columns: ['class_id'],
          references: { schema: 'public', table: 'classes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'class_sessions',
        foreignKey: {
          name: 'class_sessions_offering_id_fkey',
          columns: ['offering_id'],
          references: { schema: 'public', table: 'class_offerings', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'classes',
        foreignKey: {
          name: 'classes_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'member_interest_genres',
        foreignKey: {
          name: 'member_interest_genres_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'member_regions',
        foreignKey: {
          name: 'member_regions_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'notifications',
        foreignKey: {
          name: 'notifications_recipient_member_id_fkey',
          columns: ['recipient_member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'notifications',
        foreignKey: {
          name: 'notifications_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'notifications',
        foreignKey: {
          name: 'notifications_reservation_id_fkey',
          columns: ['reservation_id'],
          references: { schema: 'public', table: 'reservations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'order_events',
        foreignKey: {
          name: 'order_events_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orders',
        foreignKey: {
          name: 'orders_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orders',
        foreignKey: {
          name: 'orders_offering_id_fkey',
          columns: ['offering_id'],
          references: { schema: 'public', table: 'class_offerings', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'orders',
        foreignKey: {
          name: 'orders_refund_notice_version_id_fkey',
          columns: ['refund_notice_version_id'],
          references: { schema: 'public', table: 'refund_notice_versions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'payment_exceptions',
        foreignKey: {
          name: 'payment_exceptions_payment_id_fkey',
          columns: ['payment_id'],
          references: { schema: 'public', table: 'payments', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'payment_exceptions',
        foreignKey: {
          name: 'payment_exceptions_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'payments',
        foreignKey: {
          name: 'payments_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_events',
        foreignKey: {
          name: 'refund_events_refund_id_fkey',
          columns: ['refund_id'],
          references: { schema: 'public', table: 'refunds', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refund_notice_versions',
        foreignKey: {
          name: 'refund_notice_versions_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refunds',
        foreignKey: {
          name: 'refunds_reservation_id_fkey',
          columns: ['reservation_id'],
          references: { schema: 'public', table: 'reservations', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refunds',
        foreignKey: {
          name: 'refunds_payment_id_fkey',
          columns: ['payment_id'],
          references: { schema: 'public', table: 'payments', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'reservations',
        foreignKey: {
          name: 'reservations_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'reservations',
        foreignKey: {
          name: 'reservations_offering_id_fkey',
          columns: ['offering_id'],
          references: { schema: 'public', table: 'class_offerings', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'reservations',
        foreignKey: {
          name: 'reservations_seat_pool_id_fkey',
          columns: ['seat_pool_id'],
          references: { schema: 'public', table: 'seat_pools', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'reservations',
        foreignKey: {
          name: 'reservations_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'seat_pools',
        foreignKey: {
          name: 'seat_pools_offering_id_fkey',
          columns: ['offering_id'],
          references: { schema: 'public', table: 'class_offerings', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'settlement_entries',
        foreignKey: {
          name: 'settlement_entries_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'settlement_entries',
        foreignKey: {
          name: 'settlement_entries_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
