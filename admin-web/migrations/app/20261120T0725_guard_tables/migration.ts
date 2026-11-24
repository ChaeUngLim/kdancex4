#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/0f5ac0300b8189152ae50e1be764827de1921902b291da3769e549e332c21f1c/contract';
import endContract from '../../snapshots/0f5ac0300b8189152ae50e1be764827de1921902b291da3769e549e332c21f1c/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d1f7f31d8f265d102689b4ca0197f1f8ca890cba867765c67fe1f3dffe60833e/contract';
import startContract from '../../snapshots/d1f7f31d8f265d102689b4ca0197f1f8ca890cba867765c67fe1f3dffe60833e/contract.json' with { type: 'json' };
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
        table: 'academy_owners',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('ended_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('staff_account_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('started_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('active'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'academy_owners_status_check_65c583f3',
            sql`"status" IN ('active', 'ended')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'instructor_affiliations',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('applicant_message', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('decided_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('decided_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('instructor_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('invite_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('is_academy_employee', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('reject_reason_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reject_reason_text', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('release_initiated_by', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('released_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('requested_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('pending'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ck_aff_rejected_611ad5c4',
            sql`(status = 'rejected') = (reject_reason_code IS NOT NULL)`,
          ),
          checkExpression(
            'ck_aff_source_invite_c94db4d3',
            sql`(source = 'invite') = (invite_id IS NOT NULL)`,
          ),
          checkExpression(
            'instructor_affiliations_reject_reason_code_check_24d7f8c8',
            sql`"reject_reason_code" IN ('not_recruiting', 'genre_mismatch', 'info_needed', 'other')`,
          ),
          checkExpression(
            'instructor_affiliations_release_initiated_by_check_34e42fbb',
            sql`"release_initiated_by" IN ('owner', 'instructor')`,
          ),
          checkExpression(
            'instructor_affiliations_source_check_e0934815',
            sql`"source" IN ('application', 'invite')`,
          ),
          checkExpression(
            'instructor_affiliations_status_check_81b76e32',
            sql`"status" IN ('pending', 'active', 'rejected', 'withdrawn', 'released')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'instructor_delegations',
        columns: [
          col('affiliation_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('granted_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('granted_by_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('permission', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['affiliation_id', 'permission']),
          checkExpression(
            'instructor_delegations_permission_check_25bd9bbc',
            sql`"permission" IN ('roster_manage', 'class_manage')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'instructor_invites',
        columns: [
          col('academy_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_by_account_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('expires_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('revoked_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('token_hash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('used_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('used_by_account_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ck_invites_expiry_5a5e9d22', sql`expires_at > created_at`),
          checkExpression(
            'ck_invites_used_8fb55d15',
            sql`(used_at IS NULL) = (used_by_account_id IS NULL)`,
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_owners',
        index: 'academy_owners_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_owners',
        index: 'academy_owners_staff_account_id_idx_97848bfb',
        columns: ['staff_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_owners',
        index: 'ix_academy_owners_account_72499239',
        columns: ['staff_account_id', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'academy_owners',
        index: 'uq_academy_owners_active_ce5c7b07',
        columns: ['academy_id'],
        extras: { where: sql`(status = 'active')`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_affiliations',
        index: 'instructor_affiliations_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_affiliations',
        index: 'instructor_affiliations_instructor_account_id_idx_d1ef9c5f',
        columns: ['instructor_account_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_affiliations',
        index: 'instructor_affiliations_invite_id_idx_0463dbec',
        columns: ['invite_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_affiliations',
        index: 'ix_aff_academy_status_5ceea05e',
        columns: ['academy_id', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_affiliations',
        index: 'ix_aff_instructor_21342233',
        columns: ['instructor_account_id', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_affiliations',
        index: 'uq_affiliations_open_1b600c7f',
        columns: ['academy_id', 'instructor_account_id'],
        extras: { where: sql`(status IN ('pending', 'active'))`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_delegations',
        index: 'instructor_delegations_affiliation_id_idx_0c88d6bc',
        columns: ['affiliation_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_invites',
        index: 'instructor_invites_academy_id_idx_f46ade77',
        columns: ['academy_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'instructor_invites',
        index: 'uq_invites_token_hash_caa64aca',
        columns: ['token_hash'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_owners',
        foreignKey: {
          name: 'academy_owners_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'academy_owners',
        foreignKey: {
          name: 'academy_owners_staff_account_id_fkey',
          columns: ['staff_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_affiliations',
        foreignKey: {
          name: 'instructor_affiliations_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_affiliations',
        foreignKey: {
          name: 'instructor_affiliations_instructor_account_id_fkey',
          columns: ['instructor_account_id'],
          references: { schema: 'public', table: 'staff_accounts', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_affiliations',
        foreignKey: {
          name: 'instructor_affiliations_invite_id_fkey',
          columns: ['invite_id'],
          references: { schema: 'public', table: 'instructor_invites', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_delegations',
        foreignKey: {
          name: 'instructor_delegations_affiliation_id_fkey',
          columns: ['affiliation_id'],
          references: { schema: 'public', table: 'instructor_affiliations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'instructor_invites',
        foreignKey: {
          name: 'instructor_invites_academy_id_fkey',
          columns: ['academy_id'],
          references: { schema: 'public', table: 'academies', columns: ['id'] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
