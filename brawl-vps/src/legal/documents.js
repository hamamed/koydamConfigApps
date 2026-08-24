/**
 * Privacy policy and terms, served at /privacy and /terms.
 *
 * ## Kept in step with the app by hand
 *
 * The Flutter app ships the same text in
 * `lib/features/settings/domain/legal_documents.dart` so the in-app pages work
 * offline — a store reviewer opens them before the app has ever had network,
 * and a policy that needs a request is unreadable exactly then.
 *
 * That means two copies. Neither can be generated from the other across two
 * repositories without a build step nobody would run, so the rule is simply:
 * **edit both, and bump `UPDATED` in both.** The date is the thing to check —
 * if the app and the website disagree on it, they have drifted.
 *
 * These describe what this service actually does, which is the part a template
 * cannot get right. They are not legal advice and have not been reviewed by a
 * lawyer; the publisher is responsible for what they say.
 */

/** Must match `_updated` in the app's legal_documents.dart. */
const UPDATED = 'July 2026';

export const legalDocuments = {
  privacy: {
    title: 'Privacy Policy',
    updated: UPDATED,
    intro:
      'This app shows public Brawl Stars statistics. It has no accounts and ' +
      'no sign-in. It is free and supported by ads. What follows describes ' +
      'exactly what leaves your device, what our server keeps, and what our ' +
      'advertising partner receives.',
    sections: [
      {
        heading: 'What we do not collect',
        body:
          'No name, email address, phone number, or payment details — the app ' +
          'never asks for them. We do not sell anything about you, and we do ' +
          'not run our own analytics.',
      },
      {
        heading: 'Advertising',
        body:
          'The app shows ads through Google AdMob. To do that, Google ' +
          'receives your device’s advertising identifier, a general idea of ' +
          'where you are (from your IP address, at roughly city level), and ' +
          'basic device information such as model and operating system ' +
          'version.\n\n' +
          'On iOS you are asked before any of this is used for tracking. If ' +
          'you decline — or decline consent where that applies — you still ' +
          'see ads, but they are chosen from context rather than from ' +
          'anything about you. The app works identically either way.\n\n' +
          'We never send Google your player tag, your battles, or anything ' +
          'else you look up in the app. What Google does with the data it ' +
          'collects is governed by its own privacy policy at ' +
          'policies.google.com/privacy, and you can reset or disable the ' +
          'advertising identifier in your device settings.',
      },
      {
        heading: 'What stays on your device',
        body:
          'Your searched player tags, the battles the app has archived, ' +
          'trophy history it has recorded over time, your theme choice, and ' +
          'cached server responses. All of it is stored locally and none of it ' +
          'is uploaded. Deleting the app removes it permanently — it is not ' +
          'backed up to us and cannot be recovered.',
      },
      {
        heading: 'What our server receives',
        body:
          'When you look up a player or club, the app sends that public tag to ' +
          'our server, which fetches it from the official Brawl Stars API and ' +
          'returns the result.\n\n' +
          'Our server records that tag along with the public profile and ' +
          'battle data the API returned, and keeps it to build statistics — ' +
          'win rates, map performance, and how the meta changes over time. ' +
          'This is the same public information anyone can look up with that ' +
          'tag, and it is stored against the tag, not against you: we do not ' +
          'know which device or person made the request.',
      },
      {
        heading: 'How long it is kept',
        body:
          'Individual battle records are deleted automatically after six ' +
          'months. Aggregated statistics — win rates and trends, which cannot ' +
          'identify a player — are kept indefinitely.',
      },
      {
        heading: 'Server logs',
        body:
          'Our server keeps standard operational logs, which include IP ' +
          'addresses, for a short period so we can diagnose faults and block ' +
          'abuse. They are not linked to player tags and are not used to ' +
          'build a profile of anyone.',
      },
      {
        heading: 'Children',
        body:
          'The app collects no personal information from anyone, including ' +
          'children. If you believe a child has had personal information ' +
          'shared with us in some other way, contact us and we will remove it.',
      },
      {
        heading: 'Your choices',
        body:
          'You can clear everything the app stores locally from Settings at ' +
          'any time. To ask us to remove data associated with a specific ' +
          'player tag from our server, contact us with that tag.',
      },
      {
        heading: 'Changes',
        body:
          'If this policy changes materially, the date at the top will change ' +
          'and the updated text will ship with the next app release.',
      },
    ],
  },

  terms: {
    title: 'Terms of Service',
    updated: UPDATED,
    intro:
      'By using this app you agree to what follows. If you do not agree, ' +
      'please stop using the app.',
    sections: [
      {
        heading: 'Not affiliated with Supercell',
        body:
          'This app is unofficial fan content and is not endorsed by, ' +
          'sponsored by, or affiliated with Supercell. Supercell is not ' +
          'responsible for it. Brawl Stars, all game content, character names ' +
          'and artwork are trademarks and copyright of Supercell.\n\n' +
          'For more information, see Supercell’s Fan Content Policy: ' +
          'supercell.com/en/fan-content-policy/',
      },
      {
        heading: 'What the app provides',
        body:
          'Public game statistics, presented and analysed. Figures are ' +
          'calculated from a sample of publicly available battles, so they ' +
          'are estimates rather than official numbers, and they can be wrong ' +
          'or out of date. Nothing here is a guarantee of in-game results.',
      },
      {
        heading: 'Availability',
        body:
          'The app depends on the official Brawl Stars API and on our own ' +
          'server. Either can be slow, unavailable, or change without notice, ' +
          'and features may stop working as a result. The app is provided as ' +
          'is, without warranty of any kind.',
      },
      {
        heading: 'Acceptable use',
        body:
          'Do not attempt to disrupt the service, scrape it at a volume that ' +
          'degrades it for others, or use it to harass anyone. Player tags ' +
          'shown in the app are public game data; treating them as an ' +
          'invitation to target a person is not acceptable use.',
      },
      {
        heading: 'Liability',
        body:
          'To the extent permitted by law, we are not liable for any loss ' +
          'arising from use of the app, including inaccurate statistics or ' +
          'decisions made on the basis of them.',
      },
      {
        heading: 'Contact',
        body:
          'Questions about these terms, or a request about data associated ' +
          'with a player tag, can be sent to the contact address listed on ' +
          'the app’s store page.',
      },
    ],
  },
};
