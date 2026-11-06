#  DispoBook

Extension de navigateur qui affiche, directement sur la page **Mes envies** de [Booknode](https://booknode.com), si chaque livre est disponible dans le catalogue de votre bibliothèque municipale.

> [!WARNING]
> Ce projet n'est ni développé ni affilié à Booknode, ni à Archimed/Syracuse. C'est un outil personnel, qui ne modifie aucune donnée envoyée au serveur.


Une pastille apparaît en haut à droite de chaque livre :

| Pastille | Signification |
|---|---|
| ✅ vert | **Disponible** : au moins un exemplaire est libre |
| 🕒 orange | **Présent mais emprunté** : au catalogue, mais tous les exemplaires sont sortis |
| ❌ gris | **Non trouvé** : aucune notice ne correspond |
| ❓ rouge | **Erreur** : non configuré, catalogue injoignable ou trop de requêtes (survolez la pastille pour le détail) |

Un clic sur la pastille ouvre la recherche correspondante dans le catalogue.

## Catalogues pris en charge

- **Archimed / Syracuse**

L'architecture est faite pour ajouter d'autres systèmes (Koha, PMB, Waterbear…), voir [Ajouter un catalogue](#ajouter-un-catalogue).

## Installation
### Depuis addons.mozilla.org
*(à venir)*

### Firefox (121 ou plus)

1. Ouvrez `about:debugging#/runtime/this-firefox`.
2. Cliquez sur **Charger un module complémentaire temporaire…**.
3. Sélectionnez le fichier `manifest.json` du dossier `Dispobook`.

> Un module temporaire disparaît à la fermeture de Firefox.


### Chrome / Edge / Brave

1. Ouvrez `chrome://extensions` et activez le **mode développeur**.
2. Cliquez sur **Charger l'extension non empaquetée**.
3. Sélectionnez le dossier `booknode-biblio`.

## Configuration

La page de réglages s'ouvre automatiquement à la première installation. Vous pouvez la rouvrir en cliquant sur l'icône de l'extension.

1. Choisissez le **système de catalogue**.
2. Saisissez l'**URL de base** de votre bibliothèque, sans chemin de recherche.
3. Cliquez sur **Enregistrer** et **acceptez l'autorisation d'accès** au site du catalogue, sinon la vérification ne peut pas fonctionner.

Ouvrez ensuite votre page `https://booknode.com/profil/<vous>/biblio` : les pastilles se chargent livre par livre.

## Fonctionnement

1. Le *content script* (`content.js`) repère la section « Mes envies » et extrait le titre et l'auteur de chaque livre.
2. Il envoie chaque livre au *background* (`background.js`), qui gère la file d'attente, le cache et les erreurs.
3. L'adaptateur du catalogue interroge le portail. Pour Syracuse :
   - `POST /Portal/Recherche/Search.svc/Search` retourne les notices ;
   - `POST /Portal/Services/ILSClient.svc/CheckAvailability` retourne les exemplaires disponibles.

   Syracuse est une application monopage : le HTML de `search.aspx` ne contient pas les résultats, d'où l'appel direct à ces services.
4. Le résultat est affiché sous forme de pastille.

### Requêtes de recherche

Booknode nomme les livres « Série, Tome 1 : Sous-titre », un format rare dans les catalogues. L'extension essaie donc (2 requêtes au maximum par livre) :

1. `sous-titre auteur`
2. `série auteur`

Une notice n'est retenue que si au moins 60 % des mots du titre y apparaissent, pour éviter les faux positifs.

### Ménager le catalogue

- 1 seconde minimum entre deux appels, un livre à la fois.
- En cas de « Trop de requêtes » (HTTP 429/503 ou message dans la réponse) : pause de 30 s, puis 60 s, 90 s… jusqu'à 120 s, avec 3 tentatives.
- **Cache** : 6 h pour « disponible » et « emprunté », 24 h pour « non trouvé ». Les erreurs ne sont pas mises en cache.
- Le cache est vidé automatiquement quand vous changez de catalogue. Le bouton **Vider le cache** des réglages le vide à la main.

## Confidentialité

Seuls le **titre** et l'**auteur** des livres sont envoyés au site de votre bibliothèque. Aucun compte, aucun identifiant et aucune donnée personnelle ne sont transmis, et rien n'est envoyé à un autre serveur. Les réglages sont stockés dans `storage.sync` et le cache dans `storage.local`.

## Structure du projet

```
booknode-biblio/
├── manifest.json        Manifest V3 (Firefox + Chrome)
├── background.js        File d'attente, cache, anti-rate-limit, appels réseau
├── content.js           Lecture de Booknode + affichage des pastilles
├── options.html         Page de réglages
├── options.js           Lecture / sauvegarde des réglages
└── adapters/
    ├── index.js         Registre des adaptateurs
    └── archimed.js      Adaptateur Archimed / Syracuse
```

## Ajouter un catalogue


## Dépannage

| Symptôme | Piste |
|---|---|
| Pastille ❓ « non configuré » | Renseignez l'URL dans les réglages. |
| Pastille ❓ « accès non autorisé » | Ouvrez les réglages, cliquez sur **Enregistrer** et acceptez l'autorisation. |
| Pastille ❓ « trop de requêtes » | Attendez quelques minutes et rechargez. Au besoin, augmentez `MIN_DELAY_MS` dans `background.js`. |
| Pastille ❓ « Réponse Search inattendue » | Le format du portail diffère : copiez le message affiché au survol et adaptez `adapters/archimed.js`. |
| Un livre présent est « non trouvé » | Vérifiez la recherche en cliquant sur la pastille. Les titres Booknode (traductions, éditions) peuvent différer de ceux du catalogue. |
| Un ancien résultat persiste | Cliquez sur **Vider le cache** dans les réglages. |
| Aucune pastille | Vérifiez que vous êtes sur `booknode.com/profil/…/biblio` et que la section s'appelle bien « Mes envies ». Si Booknode a changé son HTML, ajustez `findWishSection` et `extractBooks` dans `content.js`. |

## Limites

- Booknode n'a pas d'API : l'extension lit le HTML de la page, qui peut changer.
- La détection de la disponibilité dépend du format des réponses du portail Syracuse et peut demander un ajustement selon la bibliothèque.
- Seule la section « Mes envies » est vérifiée.