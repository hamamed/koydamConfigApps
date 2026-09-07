# Prompt: finding a lawful source of Moroccan company identity data

Paste the block below into Gemini (or any research assistant). It states what has
already been tested so the answer is new ground rather than the obvious five.

---

I run a public-interest platform that tracks Moroccan public procurement. It
crawls the official portal marchespublics.gov.ma and currently holds ~76,000
award results naming ~8,200 companies that have won public contracts.

**What I need:** for those companies — ICE (Identifiant Commun de l'Entreprise),
RC (registre de commerce) number, legal form, address and city.

**Hard constraint:** I publish some of this data on a public website, so I need a
source I may lawfully *redistribute*. Scraping a source whose terms forbid
reproduction is not an option. Personal data (individual directors' names,
personal phone numbers, emails) is out of scope — Morocco's Law 09-08 applies
and I do not want to process it.

**Please do NOT suggest these. I have already tested each and they fail:**

1. **OMPIC (ompic.ma)** — refuses TCP connections on port 443 from two different
   networks (Europe and my own). Not reachable programmatically at all.
2. **DirectInfo.ma** — this IS OMPIC's own paid channel (support address
   crc@ompic.ma), not an independent source. Paid subscription, no API, and the
   page is a JavaScript shell: the company data is not in the HTML. Its legal
   notice states reproduction "des pages, des données … par quelque procédé ou
   support que ce soit, est interdite sans autorisation".
3. **Charika.ma (Inforisk)** — 992,125 Moroccan companies, but paid reports and no
   public API. Its mentions légales claim exclusive worldwide IP over structure
   *and* content and prohibit "toute reproduction, représentation, diffusion …
   par tout procédé que ce soit", naming contrefaçon with civil and criminal
   liability.
4. **OpenCorporates** — API requires a paid/approved token; robots.txt disallows
   /search and /officers; the website is behind a CAPTCHA. More importantly its
   own Open Company Data Index scores the Moroccan register 20/70: "Freely
   searchable 20/20" but **"Data freely available 0/20", directors 0/10,
   accounts 0/10, shareholders 0/10**. Coverage for Morocco is thin by design.
5. **ice.gov.ma** — returns 403 to non-browser clients, and it is a portal for a
   business to *declare its own* ICE, not a lookup-by-name service.
6. **data.gov.ma** — searched; contains only aggregate/sectoral statistics, no
   per-company records.
7. **B2B list vendors** (DataLik, Leads.ma, MarocContact, Kerix) — these sell
   marketing contact lists: personal emails and phone numbers, undisclosed
   provenance, no stated reuse terms. Wrong data and wrong legal footing.

**What I have already found that DOES work** (so you understand the shape of a
good answer): marchespublics.gov.ma publishes, free and without login, the
official list of companies **excluded from public procurement** — 290 entries,
each carrying a registre de commerce number. That is official, public, openly
reusable, and it is the only registry-grade identifier I have obtained so far.

**My questions:**

1. Are there other **official Moroccan public bodies** that publish per-company
   identifiers as a by-product of their own mandate? I am thinking of things
   like: CNSS employer listings, DGI / tax registers, customs (ADII) importer or
   exporter lists, ANRT licence holders, AMMC or Bourse de Casablanca issuer
   filings, CNSS-affiliated employer directories, ONSSA approved establishments,
   Ministry of Equipment qualified-contractor registers ("qualification et
   classification des entreprises de BTP"), regional CRI published lists, or
   *Bulletin Officiel* legal announcements. Which of these actually publish
   company name + ICE or RC, and at what URL?
2. Do any Moroccan **sector regulators or professional bodies** publish member
   registers with identifiers (e.g. approved insurers, pharmacies, transport
   licensees, laboratories, architects, notaries)?
3. Are Moroccan **legal announcements** (annonces légales — company formation,
   capital changes) published anywhere free and structured, as they are in
   France with BODACC? If so, where, and do they carry the RC?
4. Is there any **open-data or academic dataset** of Moroccan companies with a
   permissive licence — World Bank, OCP/UM6P, Open Ownership, GLEIF (LEI codes
   for Moroccan entities), or a research release?
5. If none of the above is sufficient: what is the realistic **commercial**
   route, and specifically does OMPIC or Inforisk offer a *redistribution*
   licence — not just a subscription to read? Who does one write to?

Please search in **French and Arabic** as well as English — most of these
sources will not surface in English-language results. For each source you
propose, tell me: the exact URL, which fields it exposes, whether it can be
accessed without a login, and what its terms say about reuse. I would rather
have three verified sources than twenty plausible names.
