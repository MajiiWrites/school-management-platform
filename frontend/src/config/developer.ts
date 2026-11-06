// Developer details — single source of truth for the "About Us" section.
// Everything the section shows comes from here: photo, name, tagline,
// contacts. Change a value here and every place it renders updates at once
// (public pages + admin portal footer). Only confirmed facts are listed.

export interface DeveloperInfo {
  name: string;
  /** One-line tagline shown under the name. */
  tagline: string;
  /** Display phone, e.g. 03242699437. */
  phone: string;
  /** wa.me link for the phone, e.g. https://wa.me/923242699437. */
  whatsappUrl: string;
  email: string;
  /** Path under /public — the developer's real photo. */
  photo: string;
  /** Closing line shown at the bottom of the section. */
  builtByLine: string;
}

export const DEVELOPER: DeveloperInfo = {
  name: 'Majid Ali',
  tagline: 'CS Student, The Islamia University of Bahawalpur — Freelance Web Designer, Pakistan',
  phone: '03242699437',
  whatsappUrl: 'https://wa.me/923242699437',
  email: 'majidalioffical0@gmail.com',
  photo: '/images/majid-ali.jpg',
  builtByLine: 'This application was built by Majid Ali.',
};
