import { DEVELOPER } from '../config/developer';

/**
 * "About Us" section — the LAST section on the public pages
 * (login / signup / password pages, teacher link) and, in compact form,
 * in the admin portal footer.
 *
 * Layout (as ordered): the developer's photo in a ROUND CIRCLE at the
 * top-middle-center of the section, details centered below it:
 * name (large, bold) → tagline → WhatsApp + email → built-by line.
 * All values come from src/config/developer.ts.
 */
export default function DeveloperFooter({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const d = DEVELOPER;

  if (variant === 'compact') {
    return (
      <footer className="flex items-center justify-center gap-2 border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-slate-500">
        <img
          src={d.photo}
          alt={`Photo of ${d.name}`}
          className="h-7 w-7 rounded-full object-cover ring-2 ring-brand-100"
        />
        <span>
          Developed by <span className="font-semibold text-slate-700">{d.name}</span>
          {' · '}
          {d.tagline}
        </span>
      </footer>
    );
  }

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white px-5 py-8 text-center shadow-sm">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">About Us</h2>
      <img
        src={d.photo}
        alt={`Photo of ${d.name}`}
        className="mx-auto mt-4 h-32 w-32 rounded-full border-4 border-brand-100 object-cover ring-4 ring-brand-600/20"
      />
      <p className="mt-4 text-2xl font-bold text-slate-900">{d.name}</p>
      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-slate-600">{d.tagline}</p>
      <p className="mt-3 text-sm text-slate-600">
        <span className="font-medium text-slate-700">WhatsApp: </span>
        <a
          className="font-medium text-brand-700 hover:underline"
          href={d.whatsappUrl}
          target="_blank"
          rel="noreferrer"
        >
          {d.phone}
        </a>
        {' · '}
        <span className="font-medium text-slate-700">Email: </span>
        <a className="font-medium text-brand-700 hover:underline" href={`mailto:${d.email}`}>
          {d.email}
        </a>
      </p>
      <p className="mt-4 text-sm italic text-slate-500">{d.builtByLine}</p>
    </section>
  );
}
