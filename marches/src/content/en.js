/** English public copy. See fr.js for why this lives outside src/i18n/. */
export default {
  updated: '2026-09-06',

  landing: {
    tagline: 'Moroccan public purchase notices, made readable.',
    lede:
      'This service follows the purchase notices published on Morocco’s public procurement ' +
      'portal, keeps them, and draws out what the portal does not show: what comparable work ' +
      'actually went for, who keeps winning it, and which buyers withdraw what they publish.',
    ctaSignIn: 'Sign in',
    ctaPanel: 'Open the panel',
    ctaRequest: 'Request access',
    accessNote: 'Accounts are created by an administrator — there is no open sign-up.',

    statsTitle: 'What is in the database today',
    statsNote: 'Read live from the database at the moment this page was served.',

    featuresTitle: 'What you can do with it',
    features: [
      {
        icon: 'search',
        title: 'Search and filter',
        body:
          'Objet, reference, buyer, category, place of performance, publication date, closing ' +
          'window, state. The list opens in the same order as the portal, so the first avis ' +
          'here is the first avis there.',
      },
      {
        icon: 'package',
        title: 'The line-item detail',
        body:
          'Every avis is opened and read: each article’s description, quantity, unit, VAT rate, ' +
          'the guarantees asked for, and the documents published with it.',
      },
      {
        icon: 'award',
        title: 'What work like this goes for',
        body:
          'On every avis: the median of comparable awards, the usual range around it, the ' +
          'typical number of bids received, and how often such work ends with nobody awarded. ' +
          'Below five comparable awards it says it cannot tell you, rather than offering a ' +
          'figure it cannot stand behind.',
      },
      {
        icon: 'rotate-ccw',
        title: 'Purchases already put out once',
        body:
          'When a buyer republishes a purchase word for word, the avis says so and shows what ' +
          'happened last time: awarded to whom and for how much, or left with no winner. An ' +
          'unsuccessful precedent tells you why nobody bid.',
      },
      {
        icon: 'building-2',
        title: 'Buyer profiles',
        body:
          'How much a buyer publishes, how much of it they withdraw, what their work settles ' +
          'for, how many bids it attracts, and which companies keep winning it.',
      },
      {
        icon: 'star',
        title: 'Tracking and private notes',
        body:
          'Star the avis you care about and keep your own notes on them. Nobody else sees them.',
      },
      {
        icon: 'bell',
        title: 'Alerts',
        body:
          'Save a search and be told what is new, or how the avis you follow were settled. An ' +
          'alert with no filters at all is a daily digest of everything.',
      },
      {
        icon: 'file-text',
        title: 'Quotes and invoices',
        body:
          'Build a quote from an avis line by line and export it as a PDF under your own ' +
          'letterhead. The document stays with you: this service sends nothing to the buyer.',
      },
      {
        icon: 'languages',
        title: 'Three languages, and article translation',
        body:
          'The whole interface exists in French, English and Arabic, right-to-left for Arabic. ' +
          'An avis’s articles can be translated on demand.',
      },
    ],

    howTitle: 'Where the data comes from',
    how: [
      'Everything here comes from the public portal marchespublics.gov.ma. A crawl runs every ' +
        'morning for new notices and published results, and a deeper pass fills in the award ' +
        'history behind them.',
      'Nothing is invented and nothing is corrected: a field the portal does not publish is ' +
        'absent here too. Moroccan purchase notices carry no estimated value, for instance, so ' +
        'this service shows none.',
      'The crawl is deliberately slow — a pause between every page — and identifies itself with ' +
        'a contact address in its User-Agent.',
    ],

    roadmapTitle: 'What is planned',
    roadmapIntro: 'An intention to build, not a delivery commitment or a schedule.',
    roadmap: [
      { status: 'now', title: 'Company profiles and open data',
        body: 'Live: company profiles, results readable without an account, and CSV download.' },
      { status: 'now', title: 'A year of award history',
        body: 'The deep pass is running. It takes the medians from a seven-week snapshot to a full year.' },
      { status: 'next', title: 'Search inside the line items',
        body: 'Search already ranks by relevance over the objet; extending it to the article detail.' },
      { status: 'later', title: 'Reading the tender packs',
        body: 'Indexing what is inside the archives attached to a notice, so the specifications themselves become searchable.' },
      { status: 'later', title: 'Programmatic access',
        body: 'An API key for accounts that need one, with explicit quotas.' },
      { status: 'later', title: 'Alerts through other channels',
        body: 'Receiving alerts somewhere other than email.' },
    ],

    disclaimerTitle: 'What this service is not',
    disclaimer:
      'This site is independent. It is not affiliated with marchespublics.gov.ma, the Trésorerie ' +
      'Générale du Royaume, or any Moroccan public body. It is a working copy of a public ' +
      'portal: it can lag, be incomplete, or be wrong. For anything that matters — a deadline, ' +
      'an amount, a required document — the official portal governs.',
  },

  guide: {
    title: 'Using the panel',
    lede:
      'The panel reads top to bottom down the sidebar. Here is what each screen does, and the ' +
      'order in which they become useful.',
    sections: [
      {
        heading: 'Signing in',
        paragraphs: [
          'Accounts are created by an administrator; there is no sign-up. If you have forgotten ' +
            'your password, the “Forgot password” link on the sign-in page sends a reset link ' +
            'to your address.',
          'A session lasts twelve hours and lives in a cookie the page’s own JavaScript cannot ' +
            'read. The language picker at the foot of the sidebar switches the whole interface, ' +
            'including reading direction for Arabic.',
        ],
      },
      {
        heading: 'Projects — the list of notices',
        paragraphs: [
          'This is the home screen. The filters at the top combine: a word in the objet, a ' +
            'buyer, a category, a place, a publication date, a closing window, a state.',
          'The deadline column shows time remaining rather than a bare date, in red inside ' +
            'three days. A cancelled avis says so on its own row, with the date and the ' +
            'published reason, without opening it. The buyer’s name opens their profile.',
          'The star at the start of a row adds the avis to what you follow. The export button ' +
            'at the foot downloads the filtered list as CSV.',
        ],
      },
      {
        heading: 'Opening an avis',
        paragraphs: [
          'The header gives the buyer, category, place, procedure, publication and deadline. ' +
            'Then, where they apply: the cancellation notice and its reason, what this buyer ' +
            'already paid for the same purchase republished, what work like this goes for, the ' +
            'attached documents, and the line-item detail.',
          'The translate buttons above the articles translate them on demand. A translation is ' +
            'paid for once and then kept; reading it again costs nothing.',
          '“Create a quote” carries the articles into an invoice form.',
        ],
      },
      {
        heading: 'Results and insights',
        paragraphs: [
          '“Results” lists published awards: who won, for how much, against how many bidders. ' +
            '“Insights” aggregates the same material — the companies that win most, the buyers ' +
            'that publish most, the categories, the trend by month, and how often an avis ends ' +
            'with no winner.',
          'Every row of a ranking opens: a buyer leads to their profile, a company to what they ' +
            'have won. Amounts are medians, not means — a few very large contracts pull an ' +
            'average far above a typical purchase order.',
        ],
      },
      {
        heading: 'Following and alerts',
        paragraphs: [
          '“Following” gathers the starred avis, each with the private note you attached.',
          '“Alerts” saves a search and tells you what matches it: new notices, results, or ' +
            'both. An alert with no filters simply sends you everything new each day. With no ' +
            'mail server configured, alerts are recorded and logged but not sent, and the ' +
            'screen says so plainly.',
        ],
      },
      {
        heading: 'Invoices',
        paragraphs: [
          'A quote is built line by line from an avis: tick what you are pricing and enter a ' +
            'unit price. Amounts are computed in centimes, never in floating-point, so the ' +
            'totals come out exact.',
          'The PDF carries your company letterhead as it stands in Settings at the moment the ' +
            'document is produced.',
        ],
      },
      {
        heading: 'For administrators',
        paragraphs: [
          '“Dashboard” counts what the database holds, shows the last crawl and the next, and ' +
            'watches the crawler’s health: a crawl that stops finding anything, a field that ' +
            'stops being read, a backlog that sets in.',
          '“System” shows the state of the box: the last backup and whether this database is ' +
            'actually in it, disk space, the running version, and whether mail and translation ' +
            'are configured.',
          '“Users” creates and disables accounts. “Settings” covers the site name, the ' +
            'crawler’s pace, the mail server, the translation key and the invoice letterhead. ' +
            'Secrets are written but never read back: a field left empty changes nothing.',
        ],
      },
    ],
  },

  privacy: {
    title: 'Privacy policy',
    lede: 'What this service records, why, and who it goes to. Written to be read.',
    sections: [
      {
        heading: 'What we record about you',
        paragraphs: [
          'Your account: email address, a name if you give one, role, a password hash (bcrypt — ' +
            'the password itself is never stored), and the dates you were created and last ' +
            'signed in.',
          'What you create in the tool: the avis you follow and the private notes you attach to ' +
            'them, your saved searches and the history of alerts sent, and any quotes or ' +
            'invoices you produce, including the client details you type into them.',
          'Server logs: for each request, the IP address, the timestamp, the method, the path, ' +
            'the response code and the browser identifier. They exist for diagnosis and abuse ' +
            'detection.',
        ],
      },
      {
        heading: 'Cookies',
        paragraphs: [
          'Two cookies, neither for advertising nor for analytics.',
          '“mp_token” carries your session. It is httpOnly — the page’s JavaScript cannot read ' +
            'it — sent only over HTTPS, scoped to this site, and expires after twelve hours.',
          '“lang” remembers the language you chose. It holds nothing but “fr”, “en” or “ar”.',
        ],
      },
      {
        heading: 'The portal data',
        paragraphs: [
          'The notices, results, buyers and winning companies come from the public portal ' +
            'marchespublics.gov.ma. That is information the Moroccan administration has already ' +
            'published; this service keeps and organises it, and does not obtain it from you.',
        ],
      },
      {
        heading: 'Who it goes to',
        paragraphs: [
          'Nobody, except in the two cases below, and never for commercial purposes.',
          'Translation: when you ask for an avis’s articles to be translated, the text of those ' +
            'articles is sent to the Google Cloud Translation API to be translated. That text ' +
            'comes from the public portal; no account data accompanies the request. With no key ' +
            'configured the feature is disabled and nothing is sent.',
          'Email: if a mail server is configured, your alerts and password-reset links pass ' +
            'through it. With none configured, those messages are only recorded on the server ' +
            'and go nowhere.',
        ],
      },
      {
        heading: 'What we do not use',
        paragraphs: [
          'No analytics, no trackers, no ad network, no social buttons. The pages load no font, ' +
            'script or image from any other domain — the icons are inside the page itself. ' +
            'Nothing you do here is observed by a third party.',
        ],
      },
      {
        heading: 'How long',
        paragraphs: [
          'Account data and what you create is kept for as long as the account exists. Backups ' +
            'of the database are kept about a week on rotation. Server logs follow the ' +
            'system’s usual rotation.',
        ],
      },
      {
        heading: 'Your requests',
        paragraphs: [
          'You can ask for a copy of what concerns you, correction of anything inaccurate, or ' +
            'deletion of your account and what you created in it. Write to the contact address ' +
            'below. Data drawn from the public portal is not personal data about you and is not ' +
            'deleted on that basis.',
        ],
      },
    ],
  },

  terms: {
    title: 'Terms of use',
    lede: 'The rules for using this service, and what it does not promise.',
    sections: [
      {
        heading: 'What this service does',
        paragraphs: [
          'This service collects, keeps and presents purchase notices and results published on ' +
            'the public portal marchespublics.gov.ma, and derives analysis from them.',
          'It is independent. It is not affiliated with that portal, the Trésorerie Générale du ' +
            'Royaume, or any Moroccan public body, and speaks for none of them in any way.',
        ],
      },
      {
        heading: 'Accounts',
        paragraphs: [
          'Access is by named account, created by an administrator. There is no open sign-up.',
          'You are responsible for your password and for what is done with your account. Tell ' +
            'us if you think it has been used without you. Do not share your credentials.',
        ],
      },
      {
        heading: 'Accuracy — please read',
        paragraphs: [
          'The data is a copy of a public portal. It can lag behind it, be incomplete, or be ' +
            'wrong: a portal page can change shape and break the reading of a field without ' +
            'anything saying so immediately.',
          'Do not base an irreversible decision on this site alone. For a deadline, an amount, ' +
            'a required document or a submission address, check the official portal, which ' +
            'alone governs.',
          'The price analysis is a statistical observation of past awards. It is not an ' +
            'estimate, not advice, and not a prediction of what a future contract will cost.',
        ],
      },
      {
        heading: 'Acceptable use',
        paragraphs: [
          'Use the service for your business. Do not attempt to reach accounts or data that are ' +
            'not yours, to work around rate limits, or to disrupt the service or the machine ' +
            'hosting it.',
          'Do not extract the content in bulk by automated means: it degrades the service for ' +
            'everyone else. The same data is public at source, and supervised programmatic ' +
            'access is planned — ask for it instead.',
          'Do not use this service for any purpose contrary to Moroccan law.',
        ],
      },
      {
        heading: 'What you produce',
        paragraphs: [
          'The quotes and invoices you compose are your documents. This service sends them to ' +
            'nobody — not the buyer, not the portal, not a third party — and is not a party to ' +
            'any commercial relationship between you and a public buyer.',
        ],
      },
      {
        heading: 'Availability',
        paragraphs: [
          'The service is provided as is, on a best-effort basis, with no warranty of ' +
            'availability, accuracy or fitness for a particular purpose. It may be interrupted ' +
            'for maintenance, and the crawl depends on a third-party portal over which we have ' +
            'no control.',
          'To the extent permitted by applicable law, we are not liable for a missed tender, a ' +
            'mispriced quote, or any indirect loss arising from use of this site.',
        ],
      },
      {
        heading: 'Termination and change',
        paragraphs: [
          'An account may be disabled for breach of these terms. You may ask for yours to be ' +
            'closed at any time.',
          'These terms may change; the date at the head of the page gives the last revision. A ' +
            'material change will be announced in the panel.',
        ],
      },
      {
        heading: 'Governing law',
        paragraphs: [
          'These terms are governed by Moroccan law. Failing an amicable settlement, the ' +
            'competent Moroccan courts will hear the dispute.',
        ],
      },
    ],
  },
}
