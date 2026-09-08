import { notFound } from 'next/navigation';
import { locales, type Locale } from '@/lib/i18n';
import Header from '@/components/Header';
import Hero from '@/components/Hero';
import Features from '@/components/Features';
import HowItWorks from '@/components/HowItWorks';
import CTA from '@/components/CTA';
import Footer from '@/components/Footer';
import SakanDesign from '@/components/SakanDesign';

export default function LocalePage({ params }: { params: { locale: string } }) {
  if (!locales.includes(params.locale as Locale)) notFound();
  const locale = params.locale as Locale;

  // The Arabic main page is the full product design (JS-driven SPA).
  // The English page keeps the marketing layout — those components are
  // still exported and reused elsewhere; nothing was removed.
  if (locale === 'ar') {
    return <SakanDesign />;
  }

  return (
    <>
      <Header locale={locale} />
      <main>
        <Hero locale={locale} />
        <Features locale={locale} />
        <HowItWorks locale={locale} />
        <CTA locale={locale} />
      </main>
      <Footer locale={locale} />
    </>
  );
}
