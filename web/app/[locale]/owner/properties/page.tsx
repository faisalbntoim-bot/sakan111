'use client';

/**
 * Property Authoring v1 — "عقاراتي" list + create + edit wizard + preview.
 *
 * Design constraints:
 *   - Reuses the site's existing warm-gold token palette (globals.css).
 *   - Backend does the real work: this page never trusts its own state.
 *   - Draft creation goes through POST /v1/properties/mine (status
 *     'hidden', lifecycle DRAFT). Publishing still needs the REGA
 *     compliance flow — this page never shortcuts it. The furthest
 *     the owner goes here is "إرسال للمراجعة" (POST /v1/properties/:id/submit),
 *     which flips lifecycle DRAFT → SUBMITTED for an admin to verify.
 *   - Local draft backup uses sessionStorage only. No secrets stored.
 *   - No external services, no maps, no third-party analytics.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  createPropertyDraft, getMyProperty, listMyProperties, submitPropertyForReview,
  updatePropertyDetails, getOwnerToken, setOwnerToken,
  type PropertyRow, type PricePeriod, AuthoringApiError,
} from '@/lib/property-authoring';
import { halalahsFromSAR, sarFromHalalahs, formatHalalahsAr } from '@/lib/property-money';
import { computeCompleteness } from '@/lib/property-completeness';

type StepIdx = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
const STEP_TITLES: [string, ...string[]] = [
  'نوع الإعلان', 'الموقع', 'السعر', 'المساحات',
  'الغرف والتفاصيل', 'المميزات', 'الوسائط', 'المراجعة',
];

const CATEGORY_OPTIONS: { value: string; labelAr: string }[] = [
  { value: 'apartment',  labelAr: 'شقة' },
  { value: 'villa',      labelAr: 'فيلا' },
  { value: 'duplex',     labelAr: 'دوبلكس' },
  { value: 'studio',     labelAr: 'استوديو' },
  { value: 'land',       labelAr: 'أرض' },
  { value: 'office',     labelAr: 'مكتب' },
  { value: 'shop',       labelAr: 'محل' },
  { value: 'farm',       labelAr: 'مزرعة' },
  { value: 'commercial', labelAr: 'تجاري' },
  { value: 'building',   labelAr: 'عمارة' },
];

const PURPOSE_OPTIONS: { value: string; labelAr: string }[] = [
  { value: 'sale',             labelAr: 'للبيع' },
  { value: 'rent',             labelAr: 'للإيجار السنوي' },
  { value: 'monthly',          labelAr: 'للإيجار الشهري' },
  { value: 'daily',            labelAr: 'للإيجار اليومي' },
  { value: 'commercial_rent',  labelAr: 'إيجار تجاري' },
];

/** Suggested pricePeriod based on the purpose (owner can still override). */
function periodOptionsFor(purpose: string): { value: PricePeriod; labelAr: string }[] {
  if (purpose === 'sale')            return [{ value: 'TOTAL', labelAr: 'إجمالي' }];
  if (purpose === 'daily')           return [{ value: 'DAY', labelAr: 'يوميًا' }, { value: 'WEEK', labelAr: 'أسبوعيًا' }];
  if (purpose === 'monthly')         return [{ value: 'MONTH', labelAr: 'شهريًا' }];
  if (purpose === 'commercial_rent') return [{ value: 'YEAR', labelAr: 'سنويًا' }, { value: 'MONTH', labelAr: 'شهريًا' }];
  // rent
  return [{ value: 'YEAR', labelAr: 'سنويًا' }, { value: 'MONTH', labelAr: 'شهريًا' }];
}

// ---- Sign-in gate --------------------------------------------------

function SignInGate({ onSaved, locale }: { onSaved: () => void; locale: string }) {
  const [token, setToken] = useState('');
  return (
    <div className="pa-signin">
      <h2>تسجيل الدخول للمالك</h2>
      <p className="pa-muted">
        هذه الصفحة تحتاج جلسة مصادق عليها. الصق رمز الجلسة (JWT) الصادر من واجهة تسجيل الدخول الرسمية
        في التطبيق، أو <Link href={`/${locale}/admin/login`}>تسجيل الدخول</Link>.
      </p>
      <label className="pa-field">
        <span>رمز الجلسة</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="eyJhbGciOi…"
          autoComplete="off"
        />
      </label>
      <button
        className="pa-btn pa-btn-primary"
        onClick={() => { setOwnerToken(token); onSaved(); }}
        disabled={token.trim().length < 20}
      >
        متابعة
      </button>
    </div>
  );
}

// ---- Property list "عقاراتي" --------------------------------------

function StatusBadge({ status, lifecycle }: { status: string; lifecycle: string }) {
  let label = 'مسودة';
  if (lifecycle === 'PUBLISHED') label = 'منشور';
  else if (lifecycle === 'SUBMITTED') label = 'قيد المراجعة';
  else if (lifecycle === 'VERIFIED') label = 'موثّق';
  else if (lifecycle === 'SUSPENDED') label = 'متوقف';
  else if (lifecycle === 'EXPIRED') label = 'منتهي';
  else if (status === 'sold') label = 'مباع';
  else if (status === 'rented') label = 'مؤجر';
  return <span className={`pa-badge pa-badge-${lifecycle.toLowerCase()}`}>{label}</span>;
}

function PropertyList({
  rows, onEdit, onCreate,
}: { rows: PropertyRow[]; onEdit: (id: string) => void; onCreate: () => void }) {
  return (
    <>
      <div className="pa-header">
        <h1>عقاراتي</h1>
        <button className="pa-btn pa-btn-primary" onClick={onCreate}>أضف عقارك</button>
      </div>
      {rows.length === 0 ? (
        <div className="pa-empty">
          <p>لم تضف أي عقار بعد.</p>
        </div>
      ) : (
        <ul className="pa-list">
          {rows.map((r) => (
            <li key={r.id} className="pa-list-row">
              <div className="pa-list-main">
                <div className="pa-list-num">{r.listingNumber}</div>
                <div className="pa-list-title">
                  {CATEGORY_OPTIONS.find(o => o.value === r.category)?.labelAr ?? r.category}
                  {r.city ? ' · ' + r.city : ''}
                  {r.district ? ' · ' + r.district : ''}
                </div>
                <div className="pa-list-meta">
                  <StatusBadge status={r.status} lifecycle={r.advertisementLifecycle} />
                  <span>{r.priceHalalahs != null ? formatHalalahsAr(r.priceHalalahs) + ' ر.س' : '—'}</span>
                  <time>{new Date(r.updatedAt).toLocaleDateString('ar-SA')}</time>
                </div>
              </div>
              <button className="pa-btn" onClick={() => onEdit(r.id)}>تعديل</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---- Editor / Wizard ----------------------------------------------

type EditorState = Partial<PropertyRow> & { priceSar?: string };

function LocalDraftKey(id: string) { return `sh_property_draft_${id}`; }

function loadLocalDraft(id: string): EditorState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(LocalDraftKey(id));
    return raw ? JSON.parse(raw) as EditorState : null;
  } catch { return null; }
}

function saveLocalDraft(id: string, s: EditorState): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(LocalDraftKey(id), JSON.stringify(s)); } catch { /* silent */ }
}

function clearLocalDraft(id: string): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(LocalDraftKey(id)); } catch { /* silent */ }
}

function Editor({
  initial, onDone, onCancel,
}: { initial: PropertyRow; onDone: () => void; onCancel: () => void }) {
  const [step, setStep] = useState<StepIdx>(0);
  const [state, setState] = useState<EditorState>(() => {
    const local = loadLocalDraft(initial.id);
    const priceSar = initial.priceHalalahs != null ? String(sarFromHalalahs(initial.priceHalalahs) ?? '') : '';
    return { ...initial, priceSar, ...(local ?? {}) };
  });
  const [saving, setSaving] = useState(false);
  const [errorAr, setErrorAr] = useState<string | null>(null);
  const [successAr, setSuccessAr] = useState<string | null>(null);
  const completeness = useMemo(() => computeCompleteness(state), [state]);

  // Debounced local backup so navigating between steps doesn't lose input.
  useEffect(() => {
    const t = setTimeout(() => saveLocalDraft(initial.id, state), 300);
    return () => clearTimeout(t);
  }, [state, initial.id]);

  const set = useCallback(<K extends keyof EditorState>(k: K, v: EditorState[K]) => {
    setState((s) => ({ ...s, [k]: v }));
  }, []);

  const validateBeforeSave = useCallback((): string | null => {
    if (state.priceSar && state.priceSar !== '') {
      const h = halalahsFromSAR(state.priceSar);
      if (h === null || h < 0) return 'السعر غير صحيح.';
    }
    if (state.latitude != null && (state.latitude < -90 || state.latitude > 90)) return 'إحداثيات خط العرض خارج النطاق.';
    if (state.longitude != null && (state.longitude < -180 || state.longitude > 180)) return 'إحداثيات خط الطول خارج النطاق.';
    if (state.bedrooms != null && state.bedrooms < 0) return 'عدد غرف النوم غير صحيح.';
    if (state.bathrooms != null && state.bathrooms < 0) return 'عدد دورات المياه غير صحيح.';
    if (state.parkingSpaces != null && state.parkingSpaces < 0) return 'عدد المواقف غير صحيح.';
    if (state.areaSqm != null && state.areaSqm < 0) return 'المساحة غير صحيحة.';
    return null;
  }, [state]);

  const save = useCallback(async (): Promise<PropertyRow | null> => {
    const v = validateBeforeSave();
    if (v) { setErrorAr(v); return null; }
    setErrorAr(null);
    setSaving(true);
    try {
      const price = state.priceSar && state.priceSar !== ''
        ? halalahsFromSAR(state.priceSar)
        : (state.priceSar === '' ? null : undefined);
      const patch: Record<string, unknown> = {
        city: state.city ?? null,
        district: state.district ?? null,
        addressText: state.addressText ?? null,
        latitude: state.latitude ?? null,
        longitude: state.longitude ?? null,
        pricePeriod: state.pricePeriod ?? null,
        areaSqm: state.areaSqm ?? null,
        landAreaSqm: state.landAreaSqm ?? null,
        builtAreaSqm: state.builtAreaSqm ?? null,
        bedrooms: state.bedrooms ?? null,
        bathrooms: state.bathrooms ?? null,
        livingRooms: state.livingRooms ?? null,
        kitchens: state.kitchens ?? null,
        floorNumber: state.floorNumber ?? null,
        totalFloors: state.totalFloors ?? null,
        propertyAgeYears: state.propertyAgeYears ?? null,
        yearBuilt: state.yearBuilt ?? null,
        furnished: state.furnished ?? null,
        parkingSpaces: state.parkingSpaces ?? null,
        hasElevator: state.hasElevator ?? null,
        hasPool: state.hasPool ?? null,
        hasBalcony: state.hasBalcony ?? null,
        hasYard: state.hasYard ?? null,
        hasMaidRoom: state.hasMaidRoom ?? null,
        hasDriverRoom: state.hasDriverRoom ?? null,
        hasAirConditioning: state.hasAirConditioning ?? null,
      };
      if (price !== undefined) patch.priceHalalahs = price;
      const updated = await updatePropertyDetails(initial.id, patch);
      setSuccessAr('تم حفظ التغييرات.');
      clearLocalDraft(initial.id);
      return updated;
    } catch (e) {
      const msg = e instanceof AuthoringApiError ? e.message : 'تعذر الحفظ. حاول مجددًا.';
      setErrorAr(msg);
      return null;
    } finally {
      setSaving(false);
    }
  }, [state, initial.id, validateBeforeSave]);

  const submit = useCallback(async () => {
    const saved = await save();
    if (!saved) return;
    setSaving(true);
    try {
      await submitPropertyForReview(initial.id);
      setSuccessAr('تم إرسال العقار للمراجعة.');
      onDone();
    } catch (e) {
      const msg = e instanceof AuthoringApiError ? e.message : 'تعذر الإرسال للمراجعة.';
      setErrorAr(msg);
    } finally { setSaving(false); }
  }, [save, initial.id, onDone]);

  const periodOptions = periodOptionsFor(initial.purpose);

  return (
    <div className="pa-editor">
      <div className="pa-editor-head">
        <button className="pa-btn pa-btn-ghost" onClick={onCancel}>← عقاراتي</button>
        <div className="pa-editor-title">
          <div>{initial.listingNumber}</div>
          <StatusBadge status={initial.status} lifecycle={initial.advertisementLifecycle} />
        </div>
      </div>

      <ol className="pa-steps" aria-label="خطوات الإضافة">
        {STEP_TITLES.map((t, i) => (
          <li key={t} className={i === step ? 'on' : ''}>
            <button type="button" onClick={() => setStep(i as StepIdx)} aria-current={i === step ? 'step' : undefined}>
              <span className="pa-step-idx">{i + 1}</span>
              <span className="pa-step-name">{t}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="pa-completeness" aria-label="اكتمال البيانات">
        <div className="pa-completeness-track">
          <div className="pa-completeness-fill" style={{ width: `${completeness.percent}%` }} />
        </div>
        <div className="pa-completeness-label">اكتمال البيانات: {completeness.percent}%</div>
        {completeness.missing.length > 0 && step !== 7 ? (
          <ul className="pa-completeness-tips">
            {completeness.missing.slice(0, 3).map((h) => <li key={h}>{h}</li>)}
          </ul>
        ) : null}
      </div>

      <div className="pa-panel">
        {step === 0 && (
          <>
            <div className="pa-field">
              <span>نوع العقار</span>
              <select value={initial.category} disabled>
                {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.labelAr}</option>)}
              </select>
              <small className="pa-muted">لتغيير نوع العقار، أنشئ عقارًا جديدًا.</small>
            </div>
            <div className="pa-field">
              <span>نوع العرض</span>
              <select value={initial.purpose} disabled>
                {PURPOSE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.labelAr}</option>)}
              </select>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <label className="pa-field">
              <span>المدينة</span>
              <input value={state.city ?? ''} onChange={(e) => set('city', e.target.value)} placeholder="مثال: الرياض" />
            </label>
            <label className="pa-field">
              <span>الحي</span>
              <input value={state.district ?? ''} onChange={(e) => set('district', e.target.value)} placeholder="مثال: حي الملقا" />
            </label>
            <label className="pa-field">
              <span>العنوان</span>
              <textarea value={state.addressText ?? ''} onChange={(e) => set('addressText', e.target.value)} rows={3} placeholder="العنوان الوصفي (اختياري)" />
            </label>
          </>
        )}

        {step === 2 && (
          <>
            <label className="pa-field">
              <span>السعر (ر.س)</span>
              <input inputMode="decimal" pattern="[0-9]*" value={state.priceSar ?? ''} onChange={(e) => set('priceSar', e.target.value)} placeholder="مثال: 750000" />
              {state.priceSar && halalahsFromSAR(state.priceSar) !== null ? (
                <small className="pa-muted">≈ {formatHalalahsAr(halalahsFromSAR(state.priceSar))} ر.س</small>
              ) : null}
            </label>
            <label className="pa-field">
              <span>دورية السعر</span>
              <select value={state.pricePeriod ?? periodOptions[0]?.value ?? 'TOTAL'} onChange={(e) => set('pricePeriod', e.target.value as PricePeriod)}>
                {periodOptions.map((o) => <option key={o.value} value={o.value}>{o.labelAr}</option>)}
              </select>
            </label>
            <label className="pa-field">
              <span>العملة</span>
              <input value={initial.currency} disabled />
            </label>
          </>
        )}

        {step === 3 && (
          <>
            <NumberField label="المساحة (م²)" value={state.areaSqm ?? null} onChange={(v) => set('areaSqm', v)} min={0} />
            <NumberField label="مساحة الأرض (م²)" value={state.landAreaSqm ?? null} onChange={(v) => set('landAreaSqm', v)} min={0} />
            <NumberField label="المساحة المبنية (م²)" value={state.builtAreaSqm ?? null} onChange={(v) => set('builtAreaSqm', v)} min={0} />
          </>
        )}

        {step === 4 && (
          <>
            <NumberField label="غرف النوم" value={state.bedrooms ?? null} onChange={(v) => set('bedrooms', v)} min={0} max={50} />
            <NumberField label="دورات المياه" value={state.bathrooms ?? null} onChange={(v) => set('bathrooms', v)} min={0} max={50} />
            <NumberField label="غرف المعيشة" value={state.livingRooms ?? null} onChange={(v) => set('livingRooms', v)} min={0} max={50} />
            <NumberField label="المطابخ" value={state.kitchens ?? null} onChange={(v) => set('kitchens', v)} min={0} max={20} />
            <NumberField label="رقم الدور" value={state.floorNumber ?? null} onChange={(v) => set('floorNumber', v)} min={-10} max={200} />
            <NumberField label="عدد الأدوار" value={state.totalFloors ?? null} onChange={(v) => set('totalFloors', v)} min={0} max={200} />
            <NumberField label="عمر العقار (سنوات)" value={state.propertyAgeYears ?? null} onChange={(v) => set('propertyAgeYears', v)} min={0} max={200} />
            <NumberField label="سنة البناء" value={state.yearBuilt ?? null} onChange={(v) => set('yearBuilt', v)} min={1800} max={2200} />
          </>
        )}

        {step === 5 && (
          <>
            <BoolField label="مفروش" value={state.furnished ?? null} onChange={(v) => set('furnished', v)} />
            <NumberField label="عدد المواقف" value={state.parkingSpaces ?? null} onChange={(v) => set('parkingSpaces', v)} min={0} max={500} />
            <BoolField label="مصعد" value={state.hasElevator ?? null} onChange={(v) => set('hasElevator', v)} />
            <BoolField label="مسبح" value={state.hasPool ?? null} onChange={(v) => set('hasPool', v)} />
            <BoolField label="شرفة" value={state.hasBalcony ?? null} onChange={(v) => set('hasBalcony', v)} />
            <BoolField label="حوش" value={state.hasYard ?? null} onChange={(v) => set('hasYard', v)} />
            <BoolField label="غرفة خادمة" value={state.hasMaidRoom ?? null} onChange={(v) => set('hasMaidRoom', v)} />
            <BoolField label="غرفة سائق" value={state.hasDriverRoom ?? null} onChange={(v) => set('hasDriverRoom', v)} />
            <BoolField label="تكييف" value={state.hasAirConditioning ?? null} onChange={(v) => set('hasAirConditioning', v)} />
          </>
        )}

        {step === 6 && (
          <div className="pa-media-note">
            <p>رفع الصور والوسائط قيد التفعيل عبر خدمة الوسائط الموحّدة (/v1/media/uploads).</p>
            <p className="pa-muted">حتى تفعيل الواجهة، تُدار الوسائط من الإدارة أو من عملية الرفع الحالية في التطبيق.</p>
          </div>
        )}

        {step === 7 && <PreviewPanel state={state} initial={initial} />}
      </div>

      {errorAr ? <div role="alert" className="pa-alert pa-alert-err">{errorAr}</div> : null}
      {successAr ? <div role="status" className="pa-alert pa-alert-ok">{successAr}</div> : null}

      <div className="pa-actions">
        <button className="pa-btn" disabled={step === 0} onClick={() => setStep(((step - 1) as StepIdx))}>السابق</button>
        <button className="pa-btn pa-btn-primary" onClick={save} disabled={saving}>{saving ? 'جارٍ الحفظ…' : 'حفظ كمسودة'}</button>
        {step < 7
          ? <button className="pa-btn pa-btn-primary" onClick={() => setStep(((step + 1) as StepIdx))}>التالي</button>
          : <button className="pa-btn pa-btn-primary" onClick={submit} disabled={saving}>إرسال للمراجعة</button>}
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange, min, max }: { label: string; value: number | null; onChange: (v: number | null) => void; min?: number; max?: number }) {
  return (
    <label className="pa-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={value ?? ''}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') { onChange(null); return; }
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          onChange(n);
        }}
        min={min}
        max={max}
      />
    </label>
  );
}

function BoolField({ label, value, onChange }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <label className="pa-field pa-field-inline">
      <span>{label}</span>
      <div className="pa-toggle" role="group">
        <button type="button" className={value === true ? 'on' : ''} onClick={() => onChange(true)}>نعم</button>
        <button type="button" className={value === false ? 'on' : ''} onClick={() => onChange(false)}>لا</button>
        <button type="button" className={value == null ? 'on' : ''} onClick={() => onChange(null)}>غير محدد</button>
      </div>
    </label>
  );
}

function PreviewPanel({ state, initial }: { state: EditorState; initial: PropertyRow }) {
  const price = state.priceSar && state.priceSar !== '' ? halalahsFromSAR(state.priceSar) : initial.priceHalalahs;
  const amen = [
    state.furnished ? 'مفروش' : null,
    state.hasElevator ? 'مصعد' : null,
    state.hasPool ? 'مسبح' : null,
    state.hasBalcony ? 'شرفة' : null,
    state.hasYard ? 'حوش' : null,
    state.hasMaidRoom ? 'غرفة خادمة' : null,
    state.hasDriverRoom ? 'غرفة سائق' : null,
    state.hasAirConditioning ? 'تكييف' : null,
  ].filter((x): x is string => !!x);
  return (
    <div className="pa-preview">
      <h3>معاينة الإعلان</h3>
      <div className="pa-preview-head">
        <div className="pa-preview-type">
          {CATEGORY_OPTIONS.find(o => o.value === initial.category)?.labelAr ?? initial.category}
          {' · '}
          {PURPOSE_OPTIONS.find(o => o.value === initial.purpose)?.labelAr ?? initial.purpose}
        </div>
        <div className="pa-preview-price">
          {price != null ? formatHalalahsAr(price) + ' ر.س' : '—'}
        </div>
      </div>
      <ul className="pa-preview-facts">
        <li><b>المدينة:</b> {state.city || '—'}</li>
        <li><b>الحي:</b> {state.district || '—'}</li>
        <li><b>المساحة:</b> {state.areaSqm ?? '—'} م²</li>
        <li><b>غرف النوم:</b> {state.bedrooms ?? '—'}</li>
        <li><b>دورات المياه:</b> {state.bathrooms ?? '—'}</li>
        <li><b>المواقف:</b> {state.parkingSpaces ?? '—'}</li>
      </ul>
      {amen.length > 0 && (
        <>
          <h4>المميزات</h4>
          <ul className="pa-preview-amenities">{amen.map((a) => <li key={a}>{a}</li>)}</ul>
        </>
      )}
      <p className="pa-muted">هذه معاينة داخلية — النشر الفعلي يحتاج مراجعة الإدارة (لوائح REGA).</p>
    </div>
  );
}

// ---- Create draft modal -------------------------------------------

function CreateDraft({ onCancel, onCreated }: { onCancel: () => void; onCreated: (row: PropertyRow) => void }) {
  const [category, setCategory] = useState('apartment');
  const [purpose, setPurpose] = useState('rent');
  const [busy, setBusy] = useState(false);
  const [errorAr, setErrorAr] = useState<string | null>(null);
  return (
    <div className="pa-modal-body">
      <h2>أضف عقارك</h2>
      <label className="pa-field">
        <span>نوع العقار</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.labelAr}</option>)}
        </select>
      </label>
      <label className="pa-field">
        <span>نوع العرض</span>
        <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          {PURPOSE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.labelAr}</option>)}
        </select>
      </label>
      {errorAr ? <div role="alert" className="pa-alert pa-alert-err">{errorAr}</div> : null}
      <div className="pa-actions">
        <button className="pa-btn" onClick={onCancel}>إلغاء</button>
        <button
          className="pa-btn pa-btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true); setErrorAr(null);
            try {
              const row = await createPropertyDraft({ category, purpose });
              onCreated(row);
            } catch (e) {
              const msg = e instanceof AuthoringApiError ? e.message : 'تعذر إنشاء المسودة.';
              setErrorAr(msg);
            } finally { setBusy(false); }
          }}
        >
          {busy ? 'جارٍ الإنشاء…' : 'إنشاء مسودة'}
        </button>
      </div>
    </div>
  );
}

// ---- Page wrapper --------------------------------------------------

export default function OwnerPropertiesPage({ params }: { params: { locale: string } }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [rows, setRows] = useState<PropertyRow[] | null>(null);
  const [editing, setEditing] = useState<PropertyRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [pageErrorAr, setPageErrorAr] = useState<string | null>(null);

  useEffect(() => { setSignedIn(!!getOwnerToken()); }, []);

  const reload = useCallback(async () => {
    setPageErrorAr(null);
    try {
      const list = await listMyProperties();
      setRows(list.items ?? []);
    } catch (e) {
      const msg = e instanceof AuthoringApiError ? e.message : 'تعذر تحميل عقاراتك.';
      setPageErrorAr(msg);
      setRows([]);
    }
  }, []);

  useEffect(() => { if (signedIn) void reload(); }, [signedIn, reload]);

  return (
    <>
      <PropertyAuthoringStyles />
      <main className="pa-page" dir="rtl">
        {!signedIn && <SignInGate locale={params.locale} onSaved={() => setSignedIn(true)} />}

        {signedIn && !editing && !creating && (
          <>
            {pageErrorAr ? <div role="alert" className="pa-alert pa-alert-err">{pageErrorAr}</div> : null}
            {rows === null
              ? <div className="pa-muted">جارٍ التحميل…</div>
              : <PropertyList rows={rows} onCreate={() => setCreating(true)} onEdit={async (id) => {
                  try { setEditing(await getMyProperty(id)); }
                  catch (e) { setPageErrorAr(e instanceof AuthoringApiError ? e.message : 'تعذّر فتح العقار.'); }
                }} />}
          </>
        )}

        {signedIn && creating && (
          <CreateDraft
            onCancel={() => setCreating(false)}
            onCreated={(row) => { setCreating(false); setEditing(row); void reload(); }}
          />
        )}

        {signedIn && editing && (
          <Editor
            initial={editing}
            onDone={async () => { setEditing(null); await reload(); }}
            onCancel={() => setEditing(null)}
          />
        )}
      </main>
    </>
  );
}

// ---- Inline styles (scoped to the .pa- namespace) -----------------

function PropertyAuthoringStyles() {
  return (
    <style jsx global>{`
      .pa-page { max-width: 920px; margin: 0 auto; padding: clamp(16px, 3vw, 32px); color: var(--ink); }
      .pa-header { display: flex; justify-content: space-between; align-items: center; margin-block-end: 20px; }
      .pa-header h1 { font-size: clamp(20px, 3vw, 26px); font-weight: 700; }
      .pa-signin { max-width: 520px; margin: 40px auto; background: var(--ground-2); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 24px; box-shadow: var(--shadow); }
      .pa-signin h2 { font-size: 20px; font-weight: 700; margin-block-end: 8px; }
      .pa-muted { color: var(--ink-2); font-size: 13px; }
      .pa-btn { padding: 10px 18px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--ground-2); color: var(--ink); font-family: inherit; font-size: 14px; cursor: pointer; min-height: 44px; }
      .pa-btn:hover:not(:disabled) { border-color: var(--accent); }
      .pa-btn:disabled { opacity: .55; cursor: not-allowed; }
      .pa-btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
      .pa-btn-primary:hover:not(:disabled) { background: var(--accent-2); border-color: var(--accent-2); }
      .pa-btn-ghost { background: transparent; border-color: transparent; color: var(--ink-2); }
      .pa-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
      .pa-list-row { display: flex; gap: 12px; padding: 14px; background: var(--ground-2); border: 1px solid var(--line); border-radius: var(--radius); align-items: center; }
      .pa-list-main { flex: 1; min-width: 0; }
      .pa-list-num { font-size: 12px; color: var(--ink-2); }
      .pa-list-title { font-weight: 600; font-size: 15px; margin-block: 2px; }
      .pa-list-meta { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--ink-2); }
      .pa-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: #eee; color: #333; }
      .pa-badge-draft { background: var(--accent-soft); color: var(--accent); }
      .pa-badge-published { background: #d5efdd; color: var(--success); }
      .pa-badge-submitted, .pa-badge-verified { background: #fff2cf; color: #7a5a00; }
      .pa-badge-suspended, .pa-badge-expired { background: #f7d6cc; color: var(--danger); }
      .pa-empty { padding: 40px; text-align: center; color: var(--ink-2); border: 1px dashed var(--line); border-radius: var(--radius-lg); }
      .pa-editor-head { display: flex; justify-content: space-between; align-items: center; margin-block-end: 16px; }
      .pa-editor-title { text-align: end; }
      .pa-steps { display: flex; gap: 6px; overflow-x: auto; list-style: none; padding: 0 0 8px; margin-block-end: 16px; scrollbar-width: thin; }
      .pa-steps li button { display: flex; gap: 6px; align-items: center; padding: 8px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--ground-2); font-family: inherit; color: var(--ink-2); font-size: 13px; white-space: nowrap; cursor: pointer; min-height: 40px; }
      .pa-steps li.on button { background: var(--accent); color: #fff; border-color: var(--accent); }
      .pa-step-idx { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: rgba(255,255,255,.25); font-size: 11px; }
      .pa-completeness { margin-block-end: 16px; }
      .pa-completeness-track { height: 8px; border-radius: 999px; background: var(--line); overflow: hidden; }
      .pa-completeness-fill { height: 100%; background: var(--accent); transition: width .3s; }
      .pa-completeness-label { font-size: 12px; color: var(--ink-2); margin-block-start: 6px; }
      .pa-completeness-tips { list-style: '• '; padding-inline-start: 16px; margin-block-start: 4px; font-size: 12px; color: var(--ink-2); }
      .pa-panel { background: var(--ground-2); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 20px; display: grid; gap: 14px; }
      .pa-field { display: grid; gap: 6px; font-size: 14px; }
      .pa-field > span { color: var(--ink-2); font-size: 13px; }
      .pa-field input, .pa-field textarea, .pa-field select { padding: 10px 12px; border-radius: var(--radius); border: 1px solid var(--line); background: #fff; font-family: inherit; font-size: 14px; color: var(--ink); min-height: 44px; }
      .pa-field input:focus, .pa-field textarea:focus, .pa-field select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
      .pa-field input:disabled { background: #f5f2ea; color: var(--ink-2); }
      .pa-field-inline { grid-template-columns: 1fr auto; align-items: center; }
      .pa-toggle { display: inline-flex; gap: 4px; }
      .pa-toggle button { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; font-family: inherit; font-size: 13px; cursor: pointer; min-height: 36px; }
      .pa-toggle button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
      .pa-actions { position: sticky; bottom: 0; display: flex; gap: 8px; justify-content: flex-end; padding-block: 12px; margin-block-start: 16px; background: linear-gradient(to top, var(--ground) 60%, transparent); }
      .pa-alert { padding: 10px 12px; border-radius: var(--radius); font-size: 13px; margin-block-start: 10px; }
      .pa-alert-err { background: #f7e2dd; color: var(--danger); }
      .pa-alert-ok { background: #d5efdd; color: var(--success); }
      .pa-preview h3 { font-size: 18px; font-weight: 700; margin-block-end: 12px; }
      .pa-preview-head { display: flex; justify-content: space-between; align-items: baseline; padding-block-end: 10px; border-block-end: 1px solid var(--line); }
      .pa-preview-type { font-weight: 600; }
      .pa-preview-price { font-size: 20px; font-weight: 700; color: var(--accent); }
      .pa-preview-facts { list-style: none; padding: 0; margin-block: 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; font-size: 13px; }
      .pa-preview-amenities { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
      .pa-preview-amenities li { padding: 4px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12px; }
      .pa-media-note { padding: 12px; border-radius: var(--radius); background: #fff7e3; color: #7a5a00; font-size: 13px; }
      .pa-modal-body { max-width: 520px; margin: 0 auto; background: var(--ground-2); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 24px; box-shadow: var(--shadow); display: grid; gap: 14px; }
      .pa-modal-body h2 { font-size: 20px; font-weight: 700; }
      @media (max-width: 600px) {
        .pa-list-row { flex-direction: column; align-items: stretch; }
        .pa-list-row .pa-btn { width: 100%; }
        .pa-actions { flex-wrap: wrap; }
        .pa-actions .pa-btn { flex: 1 1 45%; }
      }
    `}</style>
  );
}
