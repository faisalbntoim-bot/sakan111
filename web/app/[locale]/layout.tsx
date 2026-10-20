import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { dirFor, getDictionary, locales, type Locale } from '@/lib/i18n';

interface Props {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = (locales.includes(rawLocale as Locale) ? rawLocale : 'ar') as Locale;
  const t = getDictionary(locale);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://sakanhub.example';
  return {
    title: {
      default: t.meta.title,
      template: `%s — ${t.footer.brand}`,
    },
    description: t.meta.description,
    metadataBase: new URL(siteUrl),
    alternates: {
      canonical: `/${locale}`,
      languages: {
        'ar-SA': '/ar',
        'en-US': '/en',
        'x-default': '/ar',
      },
    },
    openGraph: {
      title: t.meta.title,
      description: t.meta.description,
      url: `${siteUrl}/${locale}`,
      siteName: t.footer.brand,
      locale: locale === 'ar' ? 'ar_SA' : 'en_US',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: t.meta.title,
      description: t.meta.description,
    },
    icons: {
      icon: [
        { url: '/favicon.svg', type: 'image/svg+xml' },
      ],
      apple: [{ url: '/apple-touch-icon.png' }],
    },
    robots: { index: true, follow: true },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f4ee' },
    { media: '(prefers-color-scheme: dark)',  color: '#16130d' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default async function LocaleLayout({ children, params }: Props) {
  const { locale: rawLocale } = await params;
  if (!locales.includes(rawLocale as Locale)) notFound();
  const locale = rawLocale as Locale;
  return (
    <html lang={locale} dir={dirFor(locale)}>
      <body dir={dirFor(locale)}>{children}</body>
    </html>
  );
}
