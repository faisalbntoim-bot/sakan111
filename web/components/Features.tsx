import { getDictionary, type Locale } from '@/lib/i18n';

// Minimal inline SVG icon set — no external font/asset dep.
const icons: Record<string, React.JSX.Element> = {
  shield: (<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z"/></svg>),
  verify: (<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>),
  wallet: (<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="15" r="1.5"/></svg>),
  ar: (<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8l8-4 8 4-8 4-8-4z"/><path d="M4 8v8l8 4V12"/><path d="M20 8v8l-8 4"/></svg>),
  auth: (<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>),
  roles: (<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.2"/><circle cx="17" cy="10" r="2.4"/><path d="M3 20c1-3.5 3.5-5.5 6-5.5s5 2 6 5.5"/><path d="M15 20c.6-2.4 2-3.8 3.5-3.8S21 17.7 21 20"/></svg>),
};

export default function Features({ locale }: { locale: Locale }) {
  const t = getDictionary(locale);
  return (
    <section id="features" className="section section-alt">
      <div className="wrap">
        <h2 className="section-title">{t.features.title}</h2>
        <div className="grid-3">
          {t.features.items.map((f) => (
            <article className="card" key={f.title}>
              <span className="icon" aria-hidden>{icons[f.icon] ?? icons.shield}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
