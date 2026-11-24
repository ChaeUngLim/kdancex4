#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/353ddc7e2ed5295000fc78153a53cbd81076a176794daa0cfa2586291e730b83/contract';
import endContract from '../../snapshots/353ddc7e2ed5295000fc78153a53cbd81076a176794daa0cfa2586291e730b83/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/e3f914404eefe40f8ee420bc1238a9532ed353707433f00c97e8c170cd8e1ef7/contract';
import startContract from '../../snapshots/e3f914404eefe40f8ee420bc1238a9532ed353707433f00c97e8c170cd8e1ef7/contract.json' with { type: 'json' };
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

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'candidate_contact_consents',
        columns: [
          col('consented', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('consented_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('withdrawn_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['member_id']),
          checkExpression(
            'ck_candidate_consents_state_7ff7c931',
            sql`NOT consented OR (consented_at IS NOT NULL AND withdrawn_at IS NULL)`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'course_completions',
        columns: [
          col('attended_sessions', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('completed', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('evaluated_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('level_awarded', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('offering_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('order_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('promotion_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('reservation_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('total_sessions', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_completions_award_3f40fb43',
            sql`level_awarded = (promotion_id IS NOT NULL)`,
          ),
          checkExpression(
            'ck_completions_award_requires_completed_b0804dae',
            sql`completed OR NOT level_awarded`,
          ),
          checkExpression(
            'ck_completions_sessions_336cecd1',
            sql`total_sessions >= 0 AND attended_sessions BETWEEN 0 AND total_sessions`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'instructor_level_evaluations',
        columns: [
          col('detail_genre', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('eval_level', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('evaluated_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('instructor_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['instructor_account_id', 'member_id', 'detail_genre']),
          checkExpression('ck_evaluations_range_8d3159fd', sql`eval_level BETWEEN 0 AND 10`),
          checkExpression(
            'instructor_level_evaluations_detail_genre_check_b2aeeee8',
            sql`"detail_genre" IN ('cha_cha_cha', 'samba', 'rumba', 'paso_doble', 'jive', 'waltz', 'tango', 'viennese_waltz', 'slow_foxtrot', 'quickstep', 'argentine_tango', 'swing', 'salsa', 'bachata')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'level_cards',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('detail_genre', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('level', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('promotion_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('revealed_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_level_cards_range_f2c53a76', sql`level BETWEEN 0 AND 10`),
          checkExpression(
            'level_cards_detail_genre_check_b2aeeee8',
            sql`"detail_genre" IN ('cha_cha_cha', 'samba', 'rumba', 'paso_doble', 'jive', 'waltz', 'tango', 'viennese_waltz', 'slow_foxtrot', 'quickstep', 'argentine_tango', 'swing', 'salsa', 'bachata')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'level_offers',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('detail_genre', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('from_level', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('instructor_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('offered_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('offering_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('responded_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('offered'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('to_level', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_level_offers_range_a28913e2',
            sql`from_level BETWEEN 0 AND 10 AND to_level BETWEEN 0 AND 10`,
          ),
          checkExpression(
            'ck_level_offers_responded_980c9e37',
            sql`(status IN ('accepted', 'declined')) = (responded_at IS NOT NULL)`,
          ),
          checkExpression('ck_level_offers_up_8b94252f', sql`to_level > from_level`),
          checkExpression(
            'level_offers_detail_genre_check_b2aeeee8',
            sql`"detail_genre" IN ('cha_cha_cha', 'samba', 'rumba', 'paso_doble', 'jive', 'waltz', 'tango', 'viennese_waltz', 'slow_foxtrot', 'quickstep', 'argentine_tango', 'swing', 'salsa', 'bachata')`,
          ),
          checkExpression(
            'level_offers_status_check_29a60473',
            sql`"status" IN ('offered', 'accepted', 'declined', 'superseded')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'level_promotions',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('detail_genre', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('from_level', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('offer_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('offering_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('to_level', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_promotions_completion_step_0f458c84',
            sql`source <> 'course_completion' OR to_level = from_level + 1`,
          ),
          checkExpression(
            'ck_promotions_range_a28913e2',
            sql`from_level BETWEEN 0 AND 10 AND to_level BETWEEN 0 AND 10`,
          ),
          checkExpression(
            'ck_promotions_source_e834a733',
            sql`(source = 'course_completion' AND offering_id IS NOT NULL AND offer_id IS NULL) OR (source = 'instructor_offer' AND offer_id IS NOT NULL)`,
          ),
          checkExpression('ck_promotions_up_8b94252f', sql`to_level > from_level`),
          checkExpression(
            'level_promotions_detail_genre_check_b2aeeee8',
            sql`"detail_genre" IN ('cha_cha_cha', 'samba', 'rumba', 'paso_doble', 'jive', 'waltz', 'tango', 'viennese_waltz', 'slow_foxtrot', 'quickstep', 'argentine_tango', 'swing', 'salsa', 'bachata')`,
          ),
          checkExpression(
            'level_promotions_source_check_9efd224a',
            sql`"source" IN ('course_completion', 'instructor_offer')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'member_genre_levels',
        columns: [
          col('detail_genre', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('level', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('member_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['member_id', 'detail_genre']),
          checkExpression('ck_levels_range_f2c53a76', sql`level BETWEEN 0 AND 10`),
          checkExpression(
            'member_genre_levels_detail_genre_check_b2aeeee8',
            sql`"detail_genre" IN ('cha_cha_cha', 'samba', 'rumba', 'paso_doble', 'jive', 'waltz', 'tango', 'viennese_waltz', 'slow_foxtrot', 'quickstep', 'argentine_tango', 'swing', 'salsa', 'bachata')`,
          ),
        ],
      }),
      this.addColumn({
        schema: 'public',
        table: 'members',
        column: col('featured_level_card_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.createIndex({
        schema: 'public',
        table: 'course_completions',
        index: 'course_completions_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'course_completions',
        index: 'course_completions_offering_id_idx_47c4ad39',
        columns: ['offering_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'course_completions',
        index: 'course_completions_order_id_idx_39ad19ad',
        columns: ['order_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'course_completions',
        index: 'course_completions_promotion_id_idx_bafc229f',
        columns: ['promotion_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'course_completions',
        index: 'course_completions_reservation_id_idx_919eec76',
        columns: ['reservation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'course_completions',
        index: 'ix_completions_member_eacd86f1',
        columns: ['member_id', 'evaluated_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'course_completions',
        index: 'uq_completions_offering_member_5bb6376b',
        columns: ['offering_id', 'member_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_level_evaluations',
        index: 'instructor_level_evaluations_instructor_account_id_idx_d1ef9c5f',
        columns: ['instructor_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_level_evaluations',
        index: 'instructor_level_evaluations_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_level_evaluations',
        index: 'ix_evaluations_candidates_4f735af7',
        columns: ['instructor_account_id', 'detail_genre', 'eval_level'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_cards',
        index: 'ix_level_cards_unrevealed_587a17a9',
        columns: ['member_id'],
        extras: { where: sql`(revealed_at IS NULL)` },
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_cards',
        index: 'level_cards_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_cards',
        index: 'uq_level_cards_member_genre_level_9cbb45d3',
        columns: ['member_id', 'detail_genre', 'level'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_cards',
        index: 'uq_level_cards_promotion_308942ee',
        columns: ['promotion_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_offers',
        index: 'ix_level_offers_instructor_098b698f',
        columns: ['instructor_account_id', 'offered_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_offers',
        index: 'level_offers_instructor_account_id_idx_d1ef9c5f',
        columns: ['instructor_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_offers',
        index: 'level_offers_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_offers',
        index: 'level_offers_offering_id_idx_47c4ad39',
        columns: ['offering_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_offers',
        index: 'uq_level_offers_open_f5ba3834',
        columns: ['member_id', 'detail_genre'],
        extras: { where: sql`(status = 'offered')`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_promotions',
        index: 'ix_promotions_member_genre_d18c700b',
        columns: ['member_id', 'detail_genre', 'created_at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_promotions',
        index: 'level_promotions_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_promotions',
        index: 'level_promotions_offer_id_idx_f8c71ed4',
        columns: ['offer_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_promotions',
        index: 'level_promotions_offering_id_idx_47c4ad39',
        columns: ['offering_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_promotions',
        index: 'uq_promotions_completion_284a4aec',
        columns: ['member_id', 'offering_id'],
        extras: { where: sql`(source = 'course_completion')`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'level_promotions',
        index: 'uq_promotions_offer_ba95e250',
        columns: ['offer_id'],
        extras: { where: sql`(offer_id IS NOT NULL)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'member_genre_levels',
        index: 'member_genre_levels_member_id_idx_10d5a0e2',
        columns: ['member_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'members',
        index: 'members_featured_level_card_id_idx_980d47b2',
        columns: ['featured_level_card_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'candidate_contact_consents',
        foreignKey: {
          name: 'candidate_contact_consents_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'course_completions',
        foreignKey: {
          name: 'course_completions_offering_id_fkey',
          columns: ['offering_id'],
          references: { schema: 'public', table: 'class_offerings', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'course_completions',
        foreignKey: {
          name: 'course_completions_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'course_completions',
        foreignKey: {
          name: 'course_completions_reservation_id_fkey',
          columns: ['reservation_id'],
          references: { schema: 'public', table: 'reservations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'course_completions',
        foreignKey: {
          name: 'course_completions_order_id_fkey',
          columns: ['order_id'],
          references: { schema: 'public', table: 'orders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'course_completions',
        foreignKey: {
          name: 'course_completions_promotion_id_fkey',
          columns: ['promotion_id'],
          references: { schema: 'public', table: 'level_promotions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_level_evaluations',
        foreignKey: {
          name: 'instructor_level_evaluations_instructor_account_id_fkey',
          columns: ['instructor_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_level_evaluations',
        foreignKey: {
          name: 'instructor_level_evaluations_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'level_cards',
        foreignKey: {
          name: 'level_cards_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'level_cards',
        foreignKey: {
          name: 'level_cards_promotion_id_fkey',
          columns: ['promotion_id'],
          references: { schema: 'public', table: 'level_promotions', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'level_offers',
        foreignKey: {
          name: 'level_offers_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'level_offers',
        foreignKey: {
          name: 'level_offers_instructor_account_id_fkey',
          columns: ['instructor_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'level_offers',
        foreignKey: {
          name: 'level_offers_offering_id_fkey',
          columns: ['offering_id'],
          references: { schema: 'public', table: 'class_offerings', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'level_promotions',
        foreignKey: {
          name: 'level_promotions_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'level_promotions',
        foreignKey: {
          name: 'level_promotions_offering_id_fkey',
          columns: ['offering_id'],
          references: { schema: 'public', table: 'class_offerings', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'level_promotions',
        foreignKey: {
          name: 'level_promotions_offer_id_fkey',
          columns: ['offer_id'],
          references: { schema: 'public', table: 'level_offers', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'member_genre_levels',
        foreignKey: {
          name: 'member_genre_levels_member_id_fkey',
          columns: ['member_id'],
          references: { schema: 'public', table: 'members', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'members',
        foreignKey: {
          name: 'members_featured_level_card_id_fkey',
          columns: ['featured_level_card_id'],
          references: { schema: 'public', table: 'level_cards', columns: ['id'] },
          onDelete: 'setNull',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
