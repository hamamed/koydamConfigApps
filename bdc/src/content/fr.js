/**
 * Long-form public copy: the landing page, the panel guide, and the two legal
 * documents.
 *
 * Kept out of src/i18n/ deliberately. Those files are a flat map of short UI
 * strings where every key must exist in all three languages; this is prose,
 * structured into sections, and squeezing a privacy policy into that shape
 * would make both harder to read and to change.
 */
export default {
  updated: '2026-09-06',

  landing: {
    tagline: 'Les bons de commande publics marocains, lisibles.',
    lede:
      'Ce service suit les avis d’achat publiés sur le portail marocain des marchés publics, ' +
      'les conserve, et en tire ce que le portail ne montre pas : ce qu’un travail comparable ' +
      'a réellement été payé, qui remporte quoi, et quels acheteurs annulent ce qu’ils publient.',
    ctaSignIn: 'Se connecter',
    ctaPanel: 'Ouvrir le panneau',
    ctaRequest: 'Demander un accès',
    accessNote:
      'Les comptes sont créés par un administrateur — il n’y a pas d’inscription libre.',

    statsTitle: 'Ce que contient la base aujourd’hui',
    statsNote: 'Chiffres lus en direct dans la base, à l’instant où cette page s’affiche.',

    featuresTitle: 'Ce que vous pouvez en faire',
    features: [
      {
        icon: 'search',
        title: 'Chercher et filtrer',
        body:
          'Objet, référence, acheteur, catégorie, lieu d’exécution, date de publication, ' +
          'échéance, état. La liste s’ouvre dans le même ordre que le portail, pour que le ' +
          'premier avis ici soit le premier avis là-bas.',
      },
      {
        icon: 'package',
        title: 'Le détail article par article',
        body:
          'Chaque avis est ouvert et lu : la désignation de chaque article, la quantité, ' +
          'l’unité, le taux de TVA, les garanties demandées, et les pièces jointes publiées.',
      },
      {
        icon: 'award',
        title: 'Ce que ce type de travail rapporte',
        body:
          'Sur chaque avis : le montant médian des attributions comparables, la fourchette ' +
          'habituelle autour, le nombre de devis reçus en moyenne, et la part de ces avis qui ' +
          'se terminent sans attributaire. En dessous de cinq attributions comparables, le ' +
          'service dit qu’il ne peut pas se prononcer plutôt que d’avancer un chiffre.',
      },
      {
        icon: 'rotate-ccw',
        title: 'Les achats déjà lancés une fois',
        body:
          'Quand un acheteur republie mot pour mot un achat qu’il a déjà publié, l’avis le ' +
          'signale et montre ce qui s’était passé : attribué à qui, pour combien, ou resté ' +
          'infructueux. Un précédent infructueux dit pourquoi personne n’a répondu.',
      },
      {
        icon: 'building-2',
        title: 'Fiches acheteurs',
        body:
          'Combien un acheteur publie, quelle part il annule, ce que son travail se paie, ' +
          'combien de devis il attire, et quelles entreprises remportent ses marchés.',
      },
      {
        icon: 'star',
        title: 'Suivi et notes privées',
        body:
          'Marquez les avis qui vous intéressent et gardez-y vos propres notes. Elles ne sont ' +
          'visibles que par vous.',
      },
      {
        icon: 'bell',
        title: 'Alertes',
        body:
          'Enregistrez une recherche et recevez ce qui est nouveau, ou les résultats des avis ' +
          'que vous suivez. Une alerte sans aucun filtre est un résumé quotidien de tout.',
      },
      {
        icon: 'file-text',
        title: 'Devis et factures',
        body:
          'Composez un devis à partir des articles d’un avis, ligne par ligne, et exportez-le ' +
          'en PDF avec votre en-tête. Le document reste chez vous : rien n’est transmis à ' +
          'l’acheteur par ce service.',
      },
      {
        icon: 'languages',
        title: 'Trois langues, et la traduction des articles',
        body:
          'L’interface entière existe en français, en anglais et en arabe, en écriture ' +
          'inversée pour l’arabe. Les articles d’un avis peuvent être traduits à la demande.',
      },
    ],

    howTitle: 'D’où viennent les données',
    how: [
      'Tout ce que vous voyez ici provient du portail public marchespublics.gov.ma. ' +
        'Une collecte tourne chaque matin pour les nouveaux avis et les résultats publiés, ' +
        'et une reprise plus profonde complète l’historique des attributions.',
      'Rien n’est inventé et rien n’est corrigé : un champ absent du portail est absent ici. ' +
        'Les avis d’achat marocains ne publient pas d’estimation, par exemple, et ce service ' +
        'n’en affiche donc aucune.',
      'La collecte est volontairement lente — une pause entre chaque page — et s’annonce ' +
        'avec une adresse de contact dans son User-Agent.',
    ],

    roadmapTitle: 'Ce qui est prévu',
    roadmapIntro:
      'Une intention de travail, pas un engagement de livraison ni un calendrier.',
    roadmap: [
      { status: 'now', title: 'Fiches entreprises et données ouvertes',
        body: 'En service : les fiches entreprises, les résultats consultables sans compte, et le téléchargement en CSV.' },
      { status: 'now', title: 'Un an d’historique d’attributions',
        body: 'La reprise profonde tourne. Elle fait passer les médianes d’un instantané de sept semaines à une année entière.' },
      { status: 'next', title: 'Recherche dans les articles',
        body: 'La recherche classe déjà par pertinence sur l’objet ; l’étendre au détail article par article.' },
      { status: 'later', title: 'Lecture des dossiers de consultation',
        body: 'Indexer le contenu des archives jointes aux avis, pour chercher dans les cahiers des charges eux-mêmes.' },
      { status: 'later', title: 'Accès programmatique',
        body: 'Une clé d’API pour les comptes qui en ont l’usage, avec des quotas explicites.' },
      { status: 'later', title: 'Alertes par d’autres canaux',
        body: 'Recevoir ses alertes ailleurs que par e-mail.' },
    ],

    disclaimerTitle: 'Ce que ce service n’est pas',
    disclaimer:
      'Ce site est indépendant. Il n’est ni affilié à marchespublics.gov.ma, ni à la Trésorerie ' +
      'Générale du Royaume, ni à aucune administration marocaine. C’est une copie de travail ' +
      'd’un portail public : elle peut être en retard, incomplète, ou se tromper. Pour toute ' +
      'décision qui compte — une date limite, un montant, une pièce à fournir — le portail ' +
      'officiel fait foi.',
  },

  guide: {
    title: 'Utiliser le panneau',
    lede:
      'Le panneau se lit de haut en bas dans la barre latérale. Voici ce que fait chaque écran ' +
      'et dans quel ordre ils se rendent utiles.',
    sections: [
      {
        heading: 'Se connecter',
        paragraphs: [
          'Les comptes sont créés par un administrateur ; il n’y a pas d’inscription. Si vous ' +
            'avez oublié votre mot de passe, le lien « Mot de passe oublié » de la page de ' +
            'connexion envoie un lien de réinitialisation à votre adresse.',
          'La session dure douze heures et tient dans un cookie que le navigateur ne laisse pas ' +
            'lire au JavaScript de la page. Le sélecteur de langue en bas de la barre latérale ' +
            'change la langue de toute l’interface, y compris le sens de lecture en arabe.',
        ],
      },
      {
        heading: 'Projets — la liste des avis',
        paragraphs: [
          'C’est l’écran d’accueil. Les filtres en haut se combinent : un mot dans l’objet, un ' +
            'acheteur, une catégorie, un lieu, une date de publication minimale, une échéance ' +
            'proche, un état.',
          'La colonne d’échéance montre le temps restant plutôt qu’une date seule, en rouge à ' +
            'moins de trois jours. Un avis annulé le dit sur sa ligne, avec la date et le motif ' +
            'publié, sans qu’il faille l’ouvrir. Le nom de l’acheteur ouvre sa fiche.',
          'L’étoile en début de ligne met l’avis dans vos suivis. Le bouton d’export en bas ' +
            'télécharge la liste filtrée en CSV.',
        ],
      },
      {
        heading: 'Ouvrir un avis',
        paragraphs: [
          'L’en-tête donne l’acheteur, la catégorie, le lieu, la procédure, la publication et ' +
            'l’échéance. Viennent ensuite, s’il y a lieu : l’avis d’annulation et son motif, ce ' +
            'que l’acheteur a déjà payé pour le même achat republié, ce que rapporte ce type de ' +
            'travail, les pièces jointes, et le détail article par article.',
          'Les boutons de traduction au-dessus des articles les traduisent à la demande. Une ' +
            'traduction est payée une fois puis conservée ; la relire ne coûte rien.',
          '« Créer un devis » reprend les articles de l’avis dans un formulaire de facturation.',
        ],
      },
      {
        heading: 'Résultats et analyses',
        paragraphs: [
          '« Résultats » liste les attributions publiées : qui a gagné, pour combien, contre ' +
            'combien de concurrents. « Analyses » agrège la même matière — les entreprises qui ' +
            'gagnent le plus, les acheteurs qui publient le plus, les catégories, l’évolution ' +
            'par mois, et la part d’avis qui se terminent sans attributaire.',
          'Chaque ligne d’un classement s’ouvre : un acheteur mène à sa fiche, une entreprise à ' +
            'ce qu’elle a remporté. Les montants sont des médianes, pas des moyennes — quelques ' +
            'très gros marchés tirent une moyenne loin au-dessus d’un bon de commande courant.',
        ],
      },
      {
        heading: 'Suivis et alertes',
        paragraphs: [
          '« Suivis » rassemble les avis étoilés, chacun avec la note privée que vous y avez ' +
            'attachée.',
          '« Alertes » enregistre une recherche et vous prévient de ce qui y correspond : les ' +
            'nouveaux avis, les résultats, ou les deux. Une alerte sans aucun filtre vous ' +
            'envoie simplement tout ce qui est nouveau chaque jour. Sans serveur d’envoi ' +
            'configuré, les alertes sont enregistrées et journalisées mais pas expédiées, et ' +
            'l’écran le dit franchement.',
        ],
      },
      {
        heading: 'Factures',
        paragraphs: [
          'Un devis se compose ligne par ligne à partir des articles d’un avis : vous cochez ce ' +
            'que vous chiffrez et saisissez un prix unitaire. Les montants sont calculés en ' +
            'centimes, jamais en nombres à virgule flottante, pour que les totaux tombent juste.',
          'Le PDF porte l’en-tête de votre société, tel qu’il est renseigné dans les réglages au ' +
            'moment où le document est produit.',
        ],
      },
      {
        heading: 'Pour les administrateurs',
        paragraphs: [
          '« Tableau de bord » compte ce que contient la base, montre la dernière collecte et ' +
            'la prochaine, et surveille la santé du collecteur : une collecte qui ne rapporte ' +
            'plus rien, un champ qui cesse d’être lu, un retard qui s’installe.',
          '« Système » montre l’état de la machine : la dernière sauvegarde et si cette base y ' +
            'figure vraiment, l’espace disque, la version en service, et si l’e-mail et la ' +
            'traduction sont configurés.',
          '« Utilisateurs » crée et désactive les comptes. « Réglages » couvre le nom du site, ' +
            'le rythme du collecteur, le serveur d’envoi, la clé de traduction et l’en-tête de ' +
            'facturation. Les secrets s’écrivent sans jamais être relus : un champ laissé vide ' +
            'ne change rien.',
        ],
      },
    ],
  },

  privacy: {
    title: 'Politique de confidentialité',
    lede:
      'Ce que ce service enregistre, pourquoi, et à qui cela est transmis. Écrit pour être lu.',
    sections: [
      {
        heading: 'Ce que nous enregistrons sur vous',
        paragraphs: [
          'Votre compte : adresse e-mail, nom si vous en donnez un, rôle, empreinte de mot de ' +
            'passe (bcrypt — le mot de passe lui-même n’est jamais stocké), date de création et ' +
            'date de dernière connexion.',
          'Ce que vous créez dans l’outil : les avis que vous suivez et les notes privées que ' +
            'vous y attachez, vos recherches enregistrées et l’historique des alertes envoyées, ' +
            'et les devis ou factures que vous produisez, y compris les coordonnées de client ' +
            'que vous y saisissez.',
          'Les journaux techniques du serveur : pour chaque requête, l’adresse IP, la date, la ' +
            'méthode, l’adresse demandée, le code de réponse et l’identifiant de navigateur. ' +
            'Ils servent au diagnostic et à la détection d’abus.',
        ],
      },
      {
        heading: 'Les cookies',
        paragraphs: [
          'Deux cookies, aucun à des fins publicitaires ou de mesure d’audience.',
          '« mp_token » porte votre session. Il est httpOnly — le JavaScript de la page ne peut ' +
            'pas le lire —, transmis uniquement en HTTPS, limité à ce site, et expire au bout ' +
            'de douze heures.',
          '« lang » retient la langue choisie. Il ne contient rien d’autre que « fr », « en » ou ' +
            '« ar ».',
        ],
      },
      {
        heading: 'Les données du portail',
        paragraphs: [
          'Les avis, les résultats, les acheteurs et les entreprises attributaires proviennent ' +
            'du portail public marchespublics.gov.ma. Ce sont des informations déjà publiées ' +
            'par l’administration marocaine ; ce service les conserve et les organise, il ne ' +
            'les obtient pas de vous.',
        ],
      },
      {
        heading: 'À qui c’est transmis',
        paragraphs: [
          'À personne, sauf dans les deux cas suivants, et jamais à des fins commerciales.',
          'Traduction : lorsque vous demandez la traduction des articles d’un avis, le texte de ' +
            'ces articles est envoyé à l’API Google Cloud Translation pour être traduit. Ce ' +
            'texte provient du portail public ; aucune donnée de votre compte n’accompagne la ' +
            'requête. Si aucune clé n’est configurée, la fonction est désactivée et rien n’est ' +
            'envoyé.',
          'E-mail : si un serveur d’envoi est configuré, vos alertes et les liens de ' +
            'réinitialisation de mot de passe transitent par lui. Sans serveur configuré, ces ' +
            'messages sont seulement enregistrés côté serveur et ne partent nulle part.',
        ],
      },
      {
        heading: 'Ce que nous n’utilisons pas',
        paragraphs: [
          'Aucun outil de mesure d’audience, aucun traceur, aucune régie publicitaire, aucun ' +
            'bouton de réseau social. Les pages ne chargent ni police, ni script, ni image ' +
            'depuis un autre domaine : les icônes sont incluses dans la page elle-même. Rien ' +
            'de ce que vous faites ici n’est observé par un tiers.',
        ],
      },
      {
        heading: 'Combien de temps',
        paragraphs: [
          'Les données de compte et ce que vous y créez sont conservés tant que le compte ' +
            'existe. Les sauvegardes chiffrées de la base sont conservées environ une semaine ' +
            'par rotation. Les journaux du serveur suivent la rotation habituelle du système.',
        ],
      },
      {
        heading: 'Vos demandes',
        paragraphs: [
          'Vous pouvez demander une copie de ce qui vous concerne, la correction d’une donnée ' +
            'inexacte, ou la suppression de votre compte et de ce que vous y avez créé. Écrivez ' +
            'à l’adresse de contact ci-dessous. Les données issues du portail public ne sont ' +
            'pas des données personnelles vous concernant et ne sont pas supprimées à ce titre.',
        ],
      },
    ],
  },

  terms: {
    title: 'Conditions d’utilisation',
    lede: 'Les règles de l’usage de ce service, et ce qu’il ne promet pas.',
    sections: [
      {
        heading: 'Ce que fait ce service',
        paragraphs: [
          'Ce service collecte, conserve et présente des avis d’achat et des résultats publiés ' +
            'sur le portail public marchespublics.gov.ma, et en tire des analyses.',
          'Il est indépendant. Il n’est affilié ni à ce portail, ni à la Trésorerie Générale du ' +
            'Royaume, ni à aucune administration marocaine, et ne parle en leur nom en aucune ' +
            'façon.',
        ],
      },
      {
        heading: 'Les comptes',
        paragraphs: [
          'L’accès se fait sur compte nominatif, créé par un administrateur. Il n’y a pas ' +
            'd’inscription libre.',
          'Vous êtes responsable de votre mot de passe et de ce qui est fait avec votre compte. ' +
            'Prévenez-nous si vous pensez qu’il a été utilisé sans vous. Ne partagez pas vos ' +
            'identifiants.',
        ],
      },
      {
        heading: 'Exactitude — à lire',
        paragraphs: [
          'Les données sont une copie d’un portail public. Elles peuvent être en retard sur ' +
            'lui, incomplètes, ou erronées : une page du portail peut changer de forme et faire ' +
            'échouer la lecture d’un champ sans que rien ne le signale immédiatement.',
          'Ne fondez aucune décision irrémédiable sur ce site seul. Pour une date limite, un ' +
            'montant, une pièce exigée ou une adresse de dépôt, vérifiez sur le portail ' +
            'officiel, qui seul fait foi.',
          'Les analyses de prix sont des observations statistiques sur des attributions ' +
            'passées. Ce ne sont ni une estimation, ni un conseil, ni une prédiction de ce que ' +
            'coûtera un marché à venir.',
        ],
      },
      {
        heading: 'Usage acceptable',
        paragraphs: [
          'Servez-vous du service pour votre activité. N’essayez pas d’accéder à des comptes ou ' +
            'à des données qui ne sont pas les vôtres, de contourner les limitations de débit, ' +
            'ni de perturber le service ou la machine qui l’héberge.',
          'N’extrayez pas massivement le contenu par des moyens automatisés : cela dégrade le ' +
            'service pour les autres. Les mêmes données sont publiques à la source, et un accès ' +
            'programmatique encadré est prévu ; demandez-le plutôt.',
          'N’utilisez pas ce service à des fins contraires à la loi marocaine.',
        ],
      },
      {
        heading: 'Ce que vous produisez',
        paragraphs: [
          'Les devis et factures que vous composez sont vos documents. Ce service ne les ' +
            'transmet à personne — ni à l’acheteur, ni au portail, ni à un tiers — et n’est ' +
            'partie à aucune relation commerciale entre vous et un acheteur public.',
        ],
      },
      {
        heading: 'Disponibilité',
        paragraphs: [
          'Le service est fourni en l’état, au mieux des moyens disponibles, sans garantie de ' +
            'disponibilité, d’exactitude ni d’adéquation à un usage particulier. Il peut être ' +
            'interrompu pour maintenance, et la collecte dépend d’un portail tiers sur lequel ' +
            'nous n’avons aucune prise.',
          'Dans la limite permise par la loi applicable, notre responsabilité ne saurait être ' +
            'engagée pour un marché manqué, un devis mal chiffré ou toute perte indirecte ' +
            'résultant de l’usage de ce site.',
        ],
      },
      {
        heading: 'Résiliation et évolution',
        paragraphs: [
          'Un compte peut être désactivé en cas de manquement à ces conditions. Vous pouvez ' +
            'demander la fermeture du vôtre à tout moment.',
          'Ces conditions peuvent changer ; la date en tête de page indique la dernière ' +
            'révision. Un changement important sera signalé dans le panneau.',
        ],
      },
      {
        heading: 'Droit applicable',
        paragraphs: [
          'Ces conditions sont régies par le droit marocain. À défaut de règlement amiable, les ' +
            'tribunaux marocains compétents connaîtront du litige.',
        ],
      },
    ],
  },
}
