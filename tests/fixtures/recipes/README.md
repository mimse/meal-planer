# Recipe fixture provenance

These fixtures are **reduced snapshots** of representative pages captured on 2026-09-27. They retain only extraction-relevant canonical metadata and recipe payloads; analytics, ads, user identifiers, and unrelated page content were removed. Every retained value and field nesting is copied verbatim from the named capture; unrelated fields and repeated array members may be omitted.

| Fixture | Source URL | Capture date | Extraction kind | Capture file | Capture SHA-256 | Reduction |
| --- | --- | --- | --- | --- | --- | --- |
| `valdemarsro.html` | https://www.valdemarsro.dk/kage-med-rabarber/ | 2026-09-27 | `microdata` | `valdemarsro_dk.html` | `fee70c234c53cdf09aeace9b95997c30bd31f192cd747b217bf20c11f0261a6d` | Recipe microdata core fields; ingredients; instruction paragraphs |
| `gourministeriet.html` | https://gourministeriet.dk/frikadeller-med-perlebygsalat-broccoli-og-feta/ | 2026-09-27 | `jsonld` | `gourministeriet_dk.html` | `40adb4eb0b22bf01110a9d3523f83a4bdca1e91ae8515fe165d53a1db259c8f3` | Recipe JSON-LD; one nested section and step |
| `spisbedre.html` | https://spisbedre.dk/opskrifter/3-slags-pindemadder | 2026-09-27 | `spisbedre-inertia` | `spisbedre_dk.html` | `a54eceba0d649634dceb270a63b885da80ccc0274272ef6e94469a64376e0ba3` | Inertia recipe core fields; one member per ingredient and instruction group |
| `juliebruun.html` | https://juliebruun.com/flaeskesteg-i-airfryer/ | 2026-09-27 | `jsonld` | `juliebruun_com.html` | `5d359e6d55306716b755ed0b8096a471857dae3ce0fe9384e6a3c927dfbabc15` | Recipe JSON-LD core fields |
| `juliekarla.html` | https://www.juliekarla.dk/opskrift-bladbeder-figner-pinjekerner/ | 2026-09-27 | `jsonld` | `juliekarla_dk.html` | `f85992885ddd462231c4dc87842e8b0cd28ff48a5930fbf1e0eaacd490cb9c7a` | Recipe JSON-LD; representative HowToStep |
| `mummum.html` | https://mummum.dk/opskrift-paa-nemme-croutoner/ | 2026-09-27 | `jsonld` | `mummum_dk.html` | `6716a1b43e822364e64d7fa3c5ac84b2e89b74931587568f18651558a9f15f13` | Recipe JSON-LD core fields and source-page links |
