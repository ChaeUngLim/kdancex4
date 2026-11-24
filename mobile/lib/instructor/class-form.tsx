/**
 * 수업 만들기 본문 — 보드 I2(1/2 칸 채우기) → I2D(2/2 정규 계열) · I2E(2/2 이벤트형). S2-2.9(앱 수업 등록 화면).
 *
 * 이 컴포넌트는 「불러오기가 끝난 뒤」에만 그려진다(화면 파일이 프로필·소속·권한·임시 저장을 다 읽은 다음).
 * 그래서 칸의 처음 값은 useState 의 처음 값 하나로 정해지고, 값을 맞추는 효과 훅이 없다.
 *
 * 서버를 부르는 때(모두 버튼·칸을 바꾸는 핸들러 안에서):
 *  - 요일·시각·기간·날짜·홀을 바꿔 일정이 「다 찼을」 때 → schedule-check(겹침 미리 보기, 쓰지 않음)
 *  - 「임시 저장」 → POST(처음) 또는 PUT(그다음)
 *  - 「다음」 → 임시 저장한 뒤 2단계. 저장 응답의 환불 공지(학원 대표가 쓴 읽기 전용 판본)를 2단계에 보인다
 *  - 「수업 등록」 → 정원·환불 마감일까지 PUT 한 뒤 submit → 등록한 수업(I2S)으로
 *
 * 겹친 채로 등록하는 버튼은 없다(11 §4-2 「겹친 채로 저장하는 버튼은 없다」) — 미리 보기에서 겹치면 「다음」이 꺼지고,
 * 그래도 서버가 409(SCHEDULE_CONFLICT · ROOM_CONFLICT)를 주면 그 문장을 그대로 보인다(마지막 판정은 서버).
 */
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { newIdempotencyKey, toApiError, useApiResource } from '../catalog/use-api-resource';
import type { Genre } from '../onboarding/types';
import { colors, font, MIN_TOUCH, radius, space } from '../theme';
import {
  AGE_GROUP_LABELS,
  AGE_GROUPS,
  capacityLine,
  checkSchedule,
  CLASS_KIND_LABELS,
  CLASS_KINDS,
  DISCIPLINES_OF,
  eventFeeRows,
  genreName,
  isEventKind,
  isYmd,
  monthDayWithWeekday,
  parsePrice,
  periodLine,
  priceLine,
  regularNoticeRows,
  roomsPath,
  saveClassDraft,
  scheduleLine,
  SUB_GENRES_OF,
  TARGET_LEVEL_LABELS,
  TARGET_LEVELS,
  timeProblem,
  usesSingleCapacity,
  WEEKDAY_LABELS,
  WEEKDAYS,
  type AffiliationRoom,
  type AgeGroup,
  type ClassDraftBody,
  type ClassKind,
  type ClassRegistration,
  type ClassSchedule,
  type ScheduleCheck,
  type TargetLevel,
  type Weekday,
} from './class-api';
import { BottomButtons, Chip, ChipRow, FieldLabel, formStyles, InfoRows, SeatStepper } from './class-form-ui';
import { goBack, InstructorShell, useAction } from './staff-ui';

/** 이 강사가 수업을 올릴 수 있는 학원 하나(소속됨 + 앱 수업 등록 권한) */
export interface WritableAcademy {
  affiliationId: string;
  academyId: string;
  academyName: string;
}

/** 칸 값 전부. 숫자 칸도 글자로 들고 있다가 보낼 때 바꾼다(입력 중 「30」→「300」 같은 중간 값을 지우지 않으려고) */
export interface ClassFormValues {
  affiliationId: string;
  classKind: ClassKind;
  title: string;
  subGenre: string | null;
  discipline: string | null;
  targetLevel: TargetLevel | null;
  targetAges: AgeGroup[];
  priceText: string;
  weekdays: Weekday[];
  startTime: string;
  endTime: string;
  periodFrom: string;
  periodTo: string;
  date: string;
  roomId: string | null;
  male: number;
  female: number;
  any: number;
  refundDeadlineOn: string;
}

const CAPACITY_MAX = 999;

/** 임시 저장(있으면)으로 처음 값을 만든다. 없으면 첫 학원 · 정규 · 빈 칸 */
export function initialValues(academies: readonly WritableAcademy[], draft: ClassRegistration | null): ClassFormValues {
  const academy = academies.find((a) => a.academyId === draft?.academyId) ?? academies[0];
  const schedule = draft?.schedule ?? null;
  return {
    affiliationId: academy?.affiliationId ?? '',
    classKind: draft?.classKind ?? 'regular',
    title: draft?.title ?? '',
    subGenre: draft?.subGenre ?? null,
    discipline: draft?.discipline ?? null,
    targetLevel: draft?.targetLevel ?? null,
    targetAges: draft?.targetAges ?? [],
    priceText: draft?.priceAmount == null ? '' : String(draft.priceAmount),
    weekdays: schedule?.kind === 'recurring' ? schedule.weekdays : [],
    startTime: schedule?.startTime ?? '',
    endTime: schedule?.endTime ?? '',
    periodFrom: schedule?.kind === 'recurring' ? schedule.periodFrom : '',
    periodTo: schedule?.kind === 'recurring' ? schedule.periodTo : '',
    date: schedule?.kind === 'single' ? schedule.date : '',
    roomId: draft?.room?.roomId ?? null,
    male: draft?.capacity?.male ?? 0,
    female: draft?.capacity?.female ?? 0,
    any: draft?.capacity?.any ?? 0,
    refundDeadlineOn: draft?.refundDeadlineOn ?? '',
  };
}

/** 칸 값 → 일정. 아직 덜 찼거나 틀렸으면 null(서버에 보내지 않는다) */
function scheduleOf(v: ClassFormValues): ClassSchedule | null {
  if (timeProblem(v.startTime, v.endTime) !== null) return null;
  if (isEventKind(v.classKind)) {
    return isYmd(v.date) ? { kind: 'single', date: v.date, startTime: v.startTime, endTime: v.endTime } : null;
  }
  if (v.weekdays.length === 0 || !isYmd(v.periodFrom) || !isYmd(v.periodTo) || v.periodFrom > v.periodTo) return null;
  // 요일은 월→일 순서로 맞춰 보낸다 — 누른 순서가 달라도 같은 일정이다
  const weekdays = WEEKDAYS.filter((day) => v.weekdays.includes(day));
  return { kind: 'recurring', weekdays, startTime: v.startTime, endTime: v.endTime, periodFrom: v.periodFrom, periodTo: v.periodTo };
}

/** 칸 값 → 서버 본문(PUT 은 전체 교체라 늘 모든 칸). 아직 모르는 칸은 null 로 보낸다 */
function bodyOf(v: ClassFormValues, academyId: string, genre: Genre): ClassDraftBody {
  const price = parsePrice(v.priceText);
  const event = isEventKind(v.classKind);
  return {
    academyId,
    classKind: v.classKind,
    title: v.title.trim(),
    genre,
    subGenre: v.subGenre,
    discipline: genre === 'dance_sport' ? v.discipline : null,
    targetLevel: v.targetLevel,
    targetAges: v.targetAges,
    roomId: v.roomId,
    priceAmount: price === null || Number.isNaN(price) ? null : price,
    schedule: scheduleOf(v),
    capacity: usesSingleCapacity(v.classKind)
      ? { mode: 'single', any: v.any }
      : { mode: 'gender_split', male: v.male, female: v.female },
    // 정규 계열은 마감일을 보내도 서버가 무시한다 — 헷갈리지 않게 아예 null
    refundDeadlineOn: event && isYmd(v.refundDeadlineOn) ? v.refundDeadlineOn : null,
    introText: null,
  };
}

/** 1단계에서 빠진 칸(「다음」을 누를 수 있나). 서버 checkSubmittable 의 필수 목록 중 1단계 칸만 */
function missingOf(v: ClassFormValues, genre: Genre): string[] {
  const missing: string[] = [];
  if (v.title.trim() === '') missing.push('수업명');
  if (SUB_GENRES_OF[genre] !== undefined && v.subGenre === null) missing.push('세부 장르');
  if (genre === 'dance_sport' && v.discipline === null) missing.push('종목');
  if (!isEventKind(v.classKind) && v.targetLevel === null) missing.push('대상 레벨');
  if (v.targetAges.length === 0) missing.push('적정 연령');
  const price = parsePrice(v.priceText);
  if (price === null || Number.isNaN(price)) missing.push('금액');
  if (scheduleOf(v) === null) missing.push('요일 · 시간');
  if (v.roomId === null) missing.push('홀');
  return missing;
}

type CheckState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: ScheduleCheck }
  | { status: 'error'; message: string };

interface ClassFormProps {
  academies: readonly WritableAcademy[];
  genre: Genre;
  draft: ClassRegistration | null;
}

export function ClassForm({ academies, genre, draft }: ClassFormProps) {
  const [values, setValues] = useState<ClassFormValues>(() => initialValues(academies, draft));
  const [step, setStep] = useState<1 | 2>(1);
  // 서버에 이미 있는 수업 id — 처음 저장 전에는 null 이라 POST, 그다음부터 PUT
  const [classId, setClassId] = useState<string | null>(draft?.classId ?? null);
  // 저장 응답(2단계의 환불 공지는 여기서 읽는다)
  const [saved, setSaved] = useState<ClassRegistration | null>(draft);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  // 미리 보기를 여러 번 부르면 늦게 온 옛 응답이 새 응답을 덮을 수 있다 — 마지막 요청 번호만 받아들인다
  const checkSeq = useRef(0);
  const action = useAction();

  const academy = academies.find((a) => a.affiliationId === values.affiliationId) ?? academies[0]!;
  const rooms = useApiResource<{ items: AffiliationRoom[] }>(roomsPath(academy.affiliationId));
  const roomList = rooms.state.status === 'ready' ? rooms.state.data.items : [];
  const room = roomList.find((r) => r.roomId === values.roomId) ?? null;

  // ---- 렌더 중 계산 ----
  const event = isEventKind(values.classKind);
  const schedule = scheduleOf(values);
  const timesTyped = values.startTime !== '' && values.endTime !== '';
  const timeError = timesTyped ? timeProblem(values.startTime, values.endTime) : null;
  const missing = missingOf(values, genre);
  const checkData = check.status === 'ready' ? check.data : null;
  const overlapped = checkData !== null && (checkData.conflicts.length > 0 || checkData.roomConflicts.length > 0);
  const canNext = missing.length === 0 && !overlapped && !action.busy;
  const price = parsePrice(values.priceText);
  const free = price === 0;

  /** 겹침 미리 보기 — 일정이 다 찼을 때만 부른다. 결과가 오기 전에 칸이 또 바뀌면 그 결과는 버린다 */
  const runCheck = async (next: ClassFormValues) => {
    const nextSchedule = scheduleOf(next);
    const seq = ++checkSeq.current;
    if (nextSchedule === null) {
      setCheck({ status: 'idle' });
      return;
    }
    setCheck({ status: 'loading' });
    const nextAcademy = academies.find((a) => a.affiliationId === next.affiliationId) ?? academy;
    try {
      const data = await checkSchedule({
        academyId: nextAcademy.academyId,
        roomId: next.roomId,
        excludeClassId: classId,
        schedule: nextSchedule,
      });
      if (seq === checkSeq.current) setCheck({ status: 'ready', data });
    } catch (caught: unknown) {
      if (seq === checkSeq.current) setCheck({ status: 'error', message: toApiError(caught).detail });
    }
  };

  /** 칸 바꾸기. 일정에 걸리는 칸(recheck)이면 바로 겹침을 다시 본다 */
  const update = (patch: Partial<ClassFormValues>, recheck = false) => {
    const next = { ...values, ...patch };
    setValues(next);
    setSavedNote(null);
    if (recheck) void runCheck(next);
  };

  /** 임시 저장 한 번 — 성공하면 id·응답을 들고 있는다 */
  const save = async (v: ClassFormValues): Promise<ClassRegistration | null> => {
    const result = await action.run(() => saveClassDraft(classId, bodyOf(v, academy.academyId, genre), idempotencyKey));
    if (result !== null) {
      setClassId(result.classId);
      setSaved(result);
    }
    return result;
  };

  const handleDraft = async () => {
    if (values.title.trim() === '') {
      action.setError('임시 저장도 수업명은 있어야 해요.');
      return;
    }
    const result = await save(values);
    if (result !== null) setSavedNote('임시 저장했어요. 수업 탭에서 이어서 고칠 수 있어요.');
  };

  const handleNext = async () => {
    const result = await save(values);
    if (result !== null) setStep(2);
  };

  const handleRegister = async () => {
    // 정원·마감일까지 담아 한 번 더 저장(PUT)한 뒤, 수업 등록 마지막 단계인 홍보 이미지·소개 문구(I32B → I32)로 간다.
    // 승인 요청(submit)은 그 화면의 「검토 끝 · 수업 등록」이 보낸다 — SX-6.9(앱 홍보 이미지·소개 문구 화면).
    // 이미지·문구는 선택이라 그 화면에서 아무것도 만들지 않고 바로 등록해도 된다(FR-061a 「수업 등록 자체는 막지 않는다」)
    const result = await save(values);
    if (result !== null) router.push(`/instructor/classes/promo?classId=${result.classId}`);
  };

  const title = '수업 만들기';
  const stepBadge = <Text style={styles.stepBadge}>{`${step} / 2`}</Text>;

  if (step === 2) {
    return (
      <InstructorShell title={title} active="classes" onBack={() => setStep(1)} top={stepBadge}>
        <StepTwo
          values={values}
          event={event}
          free={free}
          saved={saved}
          schedule={schedule}
          sessionCount={checkData?.sessionCount ?? saved?.schedule?.sessionCount ?? null}
          roomName={room?.name ?? saved?.room?.name ?? null}
          academyName={academy.academyName}
          onChange={update}
        />
        {action.error !== null && <Text style={formStyles.danger}>{action.error}</Text>}
        <BottomButtons
          secondary={{ label: '이전', onPress: () => setStep(1), disabled: action.busy }}
          primary={{
            label: action.busy ? '저장하는 중' : '다음 · 홍보 이미지',
            onPress: () => void handleRegister(),
            disabled: action.busy || registerBlocker(values, event, free) !== null,
          }}
        />
        {registerBlocker(values, event, free) !== null && (
          <Text style={formStyles.hint}>{registerBlocker(values, event, free)}</Text>
        )}
      </InstructorShell>
    );
  }

  return (
    <InstructorShell title={title} active="classes" onBack={() => goBack('/instructor/academy')} top={stepBadge}>
      {draft?.revisionRequest != null && (
        <View style={formStyles.warnBox}>
          <Text style={formStyles.warnTitle}>대표가 수정을 요청했어요</Text>
          <Text style={formStyles.warnText}>{draft.revisionRequest.reason}</Text>
        </View>
      )}

      {/* 소속 학원 — 둘 이상이면 고른다. 등록한 뒤에는 학원을 바꿀 수 없다(11 §4-2 CLASS_FIELD_LOCKED) */}
      {academies.length > 1 && classId === null && (
        <View style={formStyles.section}>
          <FieldLabel title="소속 학원" />
          <ChipRow>
            {academies.map((a) => (
              <Chip
                key={a.affiliationId}
                label={a.academyName}
                selected={a.affiliationId === academy.affiliationId}
                onPress={() => update({ affiliationId: a.affiliationId, roomId: null }, true)}
              />
            ))}
          </ChipRow>
        </View>
      )}

      <View style={formStyles.section}>
        <FieldLabel title="장르 · 세부 장르" badge={`활동 장르 ${genreName(genre)}`} />
        {SUB_GENRES_OF[genre] === undefined ? (
          <Text style={formStyles.hint}>{`${genreName(genre)}는 세부 장르가 없어요.`}</Text>
        ) : (
          <ChipRow>
            {(SUB_GENRES_OF[genre] ?? []).map((sub) => (
              <Chip
                key={sub.value}
                label={sub.label}
                selected={values.subGenre === sub.value}
                // 세부 장르가 바뀌면 그 아래 종목 목록도 바뀌므로 고른 종목을 비운다
                onPress={() => update({ subGenre: sub.value, discipline: values.subGenre === sub.value ? values.discipline : null })}
              />
            ))}
          </ChipRow>
        )}
        {genre === 'dance_sport' && values.subGenre !== null && (
          <>
            <Text style={formStyles.hint}>{`${values.subGenre === 'latin' ? '라틴' : '스탠다드'} 세부 장르 · 하나만 골라요`}</Text>
            <ChipRow>
              {(DISCIPLINES_OF[values.subGenre] ?? []).map((d) => (
                <Chip key={d.value} label={d.label} selected={values.discipline === d.value} onPress={() => update({ discipline: d.value })} />
              ))}
            </ChipRow>
          </>
        )}
      </View>

      <View style={formStyles.section}>
        <FieldLabel title="수업 구분" />
        <ChipRow>
          {CLASS_KINDS.map((kind) => (
            <Chip
              key={kind}
              label={CLASS_KIND_LABELS[kind]}
              selected={values.classKind === kind}
              // 정규 ↔ 이벤트형은 일정 모양(요일 반복 ↔ 하루)이 달라 겹침을 다시 본다
              onPress={() => update({ classKind: kind }, true)}
            />
          ))}
        </ChipRow>
      </View>

      <View style={formStyles.section}>
        <FieldLabel title="대상 레벨" badge={event ? '선택' : undefined} />
        <ChipRow>
          {TARGET_LEVELS.map((level) => (
            <Chip
              key={level}
              label={TARGET_LEVEL_LABELS[level]}
              selected={values.targetLevel === level}
              // 이벤트형은 레벨 무관이 될 수 있어 같은 칩을 다시 누르면 풀린다
              onPress={() => update({ targetLevel: event && values.targetLevel === level ? null : level })}
            />
          ))}
        </ChipRow>
        <Text style={formStyles.hint}>입문 = 회원 레벨 0~1 · 레벨이 맞는 회원에게 추천돼요</Text>
      </View>

      <View style={formStyles.section}>
        <FieldLabel title="적정 연령" badge="필수 · 여러 개 가능" tone="danger" />
        <ChipRow>
          {AGE_GROUPS.map((age) => (
            <Chip key={age} multi label={AGE_GROUP_LABELS[age]} selected={values.targetAges.includes(age)} onPress={() => update({ targetAges: toggleAge(values.targetAges, age) })} />
          ))}
        </ChipRow>
        <Text style={formStyles.hint}>하나 이상 골라요 · 「전체」를 고르면 나머지는 풀려요</Text>
      </View>

      <View style={formStyles.section}>
        <FieldLabel title="수업명" />
        <TextInput
          style={formStyles.input}
          value={values.title}
          onChangeText={(text) => update({ title: text })}
          placeholder="예: 쌈바(입문) · 11월"
          placeholderTextColor={colors.ink3}
          accessibilityLabel="수업명"
          maxLength={60}
        />
      </View>

      <View style={formStyles.section}>
        <FieldLabel title="금액" />
        <TextInput
          style={formStyles.input}
          value={values.priceText}
          onChangeText={(text) => update({ priceText: text })}
          placeholder="예: 300000 · 0 이면 무료 수업"
          placeholderTextColor={colors.ink3}
          keyboardType="number-pad"
          accessibilityLabel="금액"
        />
        {price !== null && !Number.isNaN(price) && <Text style={formStyles.hint}>{priceLine(price)}</Text>}
        {price !== null && Number.isNaN(price) && <Text style={formStyles.danger}>금액은 숫자로 적어 주세요.</Text>}
      </View>

      <ScheduleFields values={values} event={event} timeError={timeError} onChange={update} />

      <View style={formStyles.section}>
        <FieldLabel title="소속 학원 · 홀" badge="필수" tone="danger" />
        <Text style={formStyles.hint}>{academy.academyName}</Text>
        {rooms.state.status === 'loading' && <Text style={formStyles.hint}>홀 목록을 불러오고 있어요</Text>}
        {rooms.state.status === 'error' && <Text style={formStyles.danger}>{rooms.state.error.detail}</Text>}
        {rooms.state.status === 'ready' && roomList.length === 0 && (
          <Text style={formStyles.danger}>이 학원에 열린 홀이 없어요. 대표에게 홀 등록을 부탁해 주세요.</Text>
        )}
        <ChipRow>
          {roomList.map((r) => (
            <Chip
              key={r.roomId}
              label={`${r.branchName} ${r.name}`}
              selected={values.roomId === r.roomId}
              onPress={() => update({ roomId: r.roomId }, true)}
            />
          ))}
        </ChipRow>
      </View>

      <OverlapNotice check={check} onPick={(start, end) => update({ startTime: start, endTime: end }, true)} />

      {action.error !== null && <Text style={formStyles.danger}>{action.error}</Text>}
      {savedNote !== null && <Text style={formStyles.okText}>{savedNote}</Text>}
      {missing.length > 0 && <Text style={formStyles.hint}>{`다음으로 가려면: ${missing.join(' · ')}`}</Text>}
      <BottomButtons
        secondary={{ label: '임시 저장', onPress: () => void handleDraft(), disabled: action.busy }}
        primary={{ label: action.busy ? '저장하는 중' : '다음', onPress: () => void handleNext(), disabled: !canNext }}
      />
    </InstructorShell>
  );
}

/** 2단계에서 「수업 등록」을 막는 사유. 없으면 null */
function registerBlocker(v: ClassFormValues, event: boolean, free: boolean): string | null {
  const total = usesSingleCapacity(v.classKind) ? v.any : v.male + v.female;
  if (total <= 0) return '정원을 1명 이상 넣어야 등록할 수 있어요.';
  if (event && !free && !isYmd(v.refundDeadlineOn)) return '환불 마감일이 비어 있으면 등록할 수 없어요.';
  if (event && !free && isYmd(v.date) && v.refundDeadlineOn > v.date) return '환불 마감일은 개최일 당일이나 그 전이어야 해요.';
  return null;
}

/** 적정 연령 칩: 「전체」를 고르면 나머지가 풀리고, 다른 것을 고르면 「전체」가 풀린다(FR-028) */
function toggleAge(current: readonly AgeGroup[], age: AgeGroup): AgeGroup[] {
  if (current.includes(age)) return current.filter((a) => a !== age);
  if (age === 'all') return ['all'];
  return [...current.filter((a) => a !== 'all'), age];
}

// ---- 요일 · 시간 칸 ---------------------------------------------------------------------------

interface ScheduleFieldsProps {
  values: ClassFormValues;
  event: boolean;
  timeError: string | null;
  onChange: (patch: Partial<ClassFormValues>, recheck?: boolean) => void;
}

/**
 * 보드 I2 「요일 · 시간 (10분 단위)」 칸. 보드는 이 칸을 누르면 I2C 로 넘어가지만, I2C 는 이 Task 의 장면이 아니라
 * 같은 입력(요일 여러 개 · 기간 · 시작·끝 시각)을 이 자리에 펼쳐 둔다. 이벤트형은 하루 날짜 하나.
 */
function ScheduleFields({ values, event, timeError, onChange }: ScheduleFieldsProps) {
  return (
    <View style={formStyles.section}>
      <FieldLabel title="요일 · 시간 (10분 단위)" />
      {event ? (
        <TextInput
          style={formStyles.input}
          value={values.date}
          onChangeText={(text) => onChange({ date: text }, true)}
          placeholder="개최일 2026-10-30"
          placeholderTextColor={colors.ink3}
          accessibilityLabel="개최일"
          maxLength={10}
        />
      ) : (
        <>
          <ChipRow>
            {WEEKDAYS.map((day) => (
              <Chip
                key={day}
                multi
                label={WEEKDAY_LABELS[day]}
                selected={values.weekdays.includes(day)}
                onPress={() =>
                  onChange(
                    { weekdays: values.weekdays.includes(day) ? values.weekdays.filter((d) => d !== day) : [...values.weekdays, day] },
                    true,
                  )
                }
              />
            ))}
          </ChipRow>
          <View style={formStyles.inputRow}>
            <TextInput
              style={[formStyles.input, formStyles.flex]}
              value={values.periodFrom}
              onChangeText={(text) => onChange({ periodFrom: text }, true)}
              placeholder="시작일 2026-11-02"
              placeholderTextColor={colors.ink3}
              accessibilityLabel="기간 시작일"
              maxLength={10}
            />
            <Text style={formStyles.hint}>–</Text>
            <TextInput
              style={[formStyles.input, formStyles.flex]}
              value={values.periodTo}
              onChangeText={(text) => onChange({ periodTo: text }, true)}
              placeholder="끝날 2026-12-23"
              placeholderTextColor={colors.ink3}
              accessibilityLabel="기간 끝날"
              maxLength={10}
            />
          </View>
        </>
      )}
      <View style={formStyles.inputRow}>
        <TextInput
          style={[formStyles.input, formStyles.flex]}
          value={values.startTime}
          onChangeText={(text) => onChange({ startTime: text }, true)}
          placeholder="시작 20:30"
          placeholderTextColor={colors.ink3}
          accessibilityLabel="시작 시각"
          maxLength={5}
        />
        <Text style={formStyles.hint}>–</Text>
        <TextInput
          style={[formStyles.input, formStyles.flex]}
          value={values.endTime}
          onChangeText={(text) => onChange({ endTime: text }, true)}
          placeholder="끝 21:30"
          placeholderTextColor={colors.ink3}
          accessibilityLabel="끝 시각"
          maxLength={5}
        />
      </View>
      {timeError !== null ? (
        <Text style={formStyles.danger}>{timeError}</Text>
      ) : (
        <Text style={formStyles.hint}>숫자로 입력해요 · 10분 단위만 받아요(예: 20:30, 20:35 는 안 돼요)</Text>
      )}
    </View>
  );
}

// ---- 겹침 안내 ---------------------------------------------------------------------------------

/**
 * 보드 I2 「겹침」 상자 — 「월 19:30 룸바(중급)과 30분 겹쳐요. 아래 빈 시간으로 바꿀 수 있어요.」 + 빈 시간 칩.
 * 칩을 누르면 시작·끝 시각을 그 시간으로 바꾼다(요일 반복은 모든 요일이 같은 시각이라 시각만 바꾸면 된다).
 */
function OverlapNotice({ check, onPick }: { check: CheckState; onPick: (start: string, end: string) => void }) {
  if (check.status === 'idle') return null;
  if (check.status === 'loading') return <Text style={formStyles.hint}>겹치는 일정이 있는지 보고 있어요</Text>;
  if (check.status === 'error') return <Text style={formStyles.danger}>{check.message}</Text>;
  const { conflicts, roomConflicts, suggestions, sessionCount } = check.data;
  if (conflicts.length === 0 && roomConflicts.length === 0) {
    return <Text style={formStyles.okText}>{`겹치는 일정 없어요 · ${sessionCount}회`}</Text>;
  }
  const first = conflicts[0] ?? roomConflicts[0]!;
  const what = conflicts.length > 0 ? `${kstWhen(first.startsAt)} ${first.label}과 ${first.overlapMinutes}분 겹쳐요.` : `이 홀은 ${kstWhen(first.startsAt)}에 다른 수업이 있어요.`;
  return (
    <View style={formStyles.warnBox} accessibilityLiveRegion="polite">
      <Text style={formStyles.warnTitle}>겹침</Text>
      <Text style={formStyles.warnText}>{`${what}${suggestions.length > 0 ? ' 아래 빈 시간으로 바꿀 수 있어요.' : ''}`}</Text>
      {suggestions.length > 0 && (
        <ChipRow>
          {suggestions.map((s) => (
            <Chip
              key={`${s.weekday}-${s.startTime}`}
              label={`${WEEKDAY_LABELS[s.weekday]} ${s.startTime}`}
              selected={false}
              onPress={() => onPick(s.startTime, s.endTime)}
            />
          ))}
        </ChipRow>
      )}
    </View>
  );
}

/** 시각(…Z) → 한국 「월 19:30」 */
function kstWhen(iso: string): string {
  const kst = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  const day = WEEKDAYS[(kst.getUTCDay() + 6) % 7]!;
  return `${WEEKDAY_LABELS[day]} ${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
}

// ---- 2단계(I2D · I2E) ---------------------------------------------------------------------------

interface StepTwoProps {
  values: ClassFormValues;
  event: boolean;
  free: boolean;
  saved: ClassRegistration | null;
  schedule: ClassSchedule | null;
  sessionCount: number | null;
  roomName: string | null;
  academyName: string;
  onChange: (patch: Partial<ClassFormValues>) => void;
}

function StepTwo({ values, event, free, saved, schedule, sessionCount, roomName, academyName, onChange }: StepTwoProps) {
  const notice = saved?.refundNotice ?? null;
  const deadlineOk = isYmd(values.refundDeadlineOn);
  return (
    <>
      <View style={formStyles.section}>
        <Text style={formStyles.hint}>{usesSingleCapacity(values.classKind) ? '정원 · 숫자를 눌러 직접 넣어도 돼요' : '정원 · 남·여 따로 · 숫자를 눌러 직접 넣어도 돼요'}</Text>
        <View style={formStyles.inputRow}>
          {usesSingleCapacity(values.classKind) ? (
            <SeatStepper label="정원" value={values.any} max={CAPACITY_MAX} onChange={(n) => onChange({ any: n })} />
          ) : (
            <>
              <SeatStepper label="남" value={values.male} max={CAPACITY_MAX} onChange={(n) => onChange({ male: n })} />
              <SeatStepper label="여" value={values.female} max={CAPACITY_MAX} onChange={(n) => onChange({ female: n })} />
            </>
          )}
        </View>
      </View>

      {event && !free && (
        <View style={formStyles.section}>
          <FieldLabel title="환불 마감일" badge="필수" tone="danger" />
          <TextInput
            style={[formStyles.input, styles.deadlineInput]}
            value={values.refundDeadlineOn}
            onChangeText={(text) => onChange({ refundDeadlineOn: text })}
            placeholder="2026-10-15"
            placeholderTextColor={colors.ink3}
            accessibilityLabel="환불 마감일"
            maxLength={10}
          />
          {deadlineOk && <Text style={styles.deadlineShown}>{monthDayWithWeekday(values.refundDeadlineOn)}</Text>}
          {isYmd(values.date) && (
            <Text style={formStyles.hint}>{`개최일 ${monthDayWithWeekday(values.date)} 당일이나 그 전 날짜만 고를 수 있어요.`}</Text>
          )}
          <Text style={formStyles.hint}>마감일 다음 날부터는 취소와 환불이 막혀요. 결제한 회원이 생기면 앞당길 수 없고 늦출 수만 있어요.</Text>
          {!deadlineOk && <Text style={formStyles.danger}>비어 있으면 등록할 수 없어요</Text>}
        </View>
      )}

      {notice === null ? (
        <View style={formStyles.noteBox}>
          <Text style={formStyles.noteText}>
            {event && free
              ? '무료 행사라 환불 마감일·취소 수수료가 없어요.'
              : `${academyName} 대표가 아직 환불·취소 공지를 올리지 않았어요. 공지가 있어야 등록할 수 있어요.`}
          </Text>
        </View>
      ) : notice.kind === 'regular' ? (
        <View style={formStyles.section}>
          <FieldLabel title="환불 · 취소 공지" badge="자동 입력" tone="accent" />
          <Text style={formStyles.hint}>{`${academyName} 대표가 쓴 공지가 그대로 들어가요. 강사는 고치거나 지울 수 없어요.`}</Text>
          <InfoRows rows={regularNoticeRows(notice.content)} />
          <View style={formStyles.noteBox}>
            <Text style={formStyles.noteText}>이미 결제한 수강생에게는 결제한 때의 공지가 그대로 적용돼요.</Text>
          </View>
        </View>
      ) : (
        <View style={formStyles.section}>
          <FieldLabel title="취소 수수료" badge="자동 입력" tone="accent" />
          <InfoRows
            valueTone="strong"
            rows={[...eventFeeRows(notice.content), { label: '환불 마감일 다음 날부터', value: '취소 · 환불 불가' }]}
          />
          <Text style={formStyles.hint}>대표가 정한 표가 그대로 들어가요. 강사는 고칠 수 없어요.</Text>
          <View style={formStyles.noteBox}>
            <Text style={formStyles.noteText}>행사는 계좌이체로만 결제받아요.</Text>
            <Text style={formStyles.noteText}>카드와 간편결제는 열리지 않아요.</Text>
            <Text style={formStyles.noteText}>참가비에 예매 수수료 2,000원이 따로 붙어요.</Text>
          </View>
        </View>
      )}

      {/* 등록할 수업 한 장 요약(보드 I2D·I2E 아래 카드) */}
      <View style={formStyles.summaryCard}>
        <Text style={formStyles.summaryTitle}>{values.title.trim()}</Text>
        {schedule !== null && (
          <Text style={formStyles.summaryLine}>
            {[scheduleLine(schedule), countLine(schedule, sessionCount), priceLine(parsePrice(values.priceText))]
              .filter((part) => part !== '')
              .join(' · ')}
          </Text>
        )}
        <Text style={formStyles.summaryLine}>
          {`${academyName} ${roomName ?? ''} · ${CLASS_KIND_LABELS[values.classKind]}${values.targetLevel === null ? '' : ` · ${TARGET_LEVEL_LABELS[values.targetLevel]}`} · ${capacityLine({ mode: usesSingleCapacity(values.classKind) ? 'single' : 'gender_split', male: values.male, female: values.female, any: values.any })}`}
        </Text>
      </View>
      <Text style={formStyles.hint}>등록하면 대표 승인을 기다려요. 승인되면 회원에게 공개돼요.</Text>
    </>
  );
}

const styles = StyleSheet.create({
  stepBadge: { alignSelf: 'flex-end', color: colors.ink3, fontSize: font.small, fontWeight: '700', marginBottom: -space.xl },
  deadlineInput: { borderColor: colors.brown, borderWidth: 1.5, minHeight: MIN_TOUCH + 4, borderRadius: radius.md },
  deadlineShown: { color: colors.ink, fontSize: 16, fontWeight: '800' },
});

/** 요약 카드의 「8주 16회」 — 기간 줄(periodLine)에서 날짜를 뺀 뒷부분. 하루 행사·회차 수 모름이면 빈 글자 */
function countLine(schedule: ClassSchedule, sessionCount: number | null): string {
  if (schedule.kind === 'single' || sessionCount === null) return '';
  return periodLine(schedule, sessionCount).split(' · ').slice(1).join(' · ');
}
