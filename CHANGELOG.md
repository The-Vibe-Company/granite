# Changelog

## [0.1.21](https://github.com/The-Vibe-Company/granite/compare/granite-mem-v0.1.20...granite-mem-v0.1.21) (2026-09-21)


### Bug Fixes

* repair slug/link resolution and contested-alias folding ([#70](https://github.com/The-Vibe-Company/granite/issues/70)) ([077422d](https://github.com/The-Vibe-Company/granite/commit/077422dcf4699036d5ffba52dec74e908915d100))

## [0.1.20](https://github.com/The-Vibe-Company/granite/compare/granite-mem-v0.1.19...granite-mem-v0.1.20) (2026-09-20)


### Features

* **mcp:** expose the fact ledger and entity alignment as MCP tools ([#69](https://github.com/The-Vibe-Company/granite/issues/69)) ([3e2fb21](https://github.com/The-Vibe-Company/granite/commit/3e2fb21b3e49c3a6bd9486f13f742b051a71a559))


### Bug Fixes

* **facts:** correct the help text shown when the ledger is empty ([#67](https://github.com/The-Vibe-Company/granite/issues/67)) ([f8f4b41](https://github.com/The-Vibe-Company/granite/commit/f8f4b4161e1d6bd1a2ecbbbf7804775af9fc13ad))

## [0.1.19](https://github.com/The-Vibe-Company/granite/compare/granite-mem-v0.1.18...granite-mem-v0.1.19) (2026-09-20)


### Bug Fixes

* **release:** write the npm auth file where npm actually reads it ([#65](https://github.com/The-Vibe-Company/granite/issues/65)) ([f1af8bc](https://github.com/The-Vibe-Company/granite/commit/f1af8bc0c6c1f5b37f0abf6c7019aa5f85279b9e))

## [0.1.18](https://github.com/The-Vibe-Company/granite/compare/granite-mem-v0.1.17...granite-mem-v0.1.18) (2026-09-20)


### Bug Fixes

* **release:** do not report a failed publish as success ([#63](https://github.com/The-Vibe-Company/granite/issues/63)) ([3a4f467](https://github.com/The-Vibe-Company/granite/commit/3a4f467bdcc63b7692db7e023d881067c9136a44))

## [0.1.17](https://github.com/The-Vibe-Company/granite/compare/granite-mem-v0.1.16...granite-mem-v0.1.17) (2026-09-20)


### Bug Fixes

* **deps:** support Node 24 by upgrading better-sqlite3 to ^13 ([#60](https://github.com/The-Vibe-Company/granite/issues/60)) ([d1ac434](https://github.com/The-Vibe-Company/granite/commit/d1ac434a8d4d91fd6e0104182c92ebce97318807))
* **release:** align the publish job with CI on Node 22 ([#58](https://github.com/The-Vibe-Company/granite/issues/58)) ([d3b4091](https://github.com/The-Vibe-Company/granite/commit/d3b40913c3eb5e63dd84e558b2b143003dbb613a))
* **release:** fall back to a token when OIDC publishing fails ([#61](https://github.com/The-Vibe-Company/granite/issues/61)) ([f82bc3e](https://github.com/The-Vibe-Company/granite/commit/f82bc3ea4788ad8610964fb68fb7c45577e2b1c4))
* **release:** restore registry-url so npm can attempt trusted publishing ([#62](https://github.com/The-Vibe-Company/granite/issues/62)) ([cfd1c1f](https://github.com/The-Vibe-Company/granite/commit/cfd1c1f9da79e4640b71bff184db4c1a492232f2))

## [0.1.16](https://github.com/The-Vibe-Company/granite/compare/granite-mem-v0.1.15...granite-mem-v0.1.16) (2026-09-20)


### Features

* **facts:** deterministic validity ledger, entity alignment, and measured Jev proposals ([#56](https://github.com/The-Vibe-Company/granite/issues/56)) ([98fd484](https://github.com/The-Vibe-Company/granite/commit/98fd4844502447eaa8d8a40aa9572601ebbb78cf))

## [0.1.15](https://github.com/The-Vibe-Company/granite/compare/granite-mem-v0.1.14...granite-mem-v0.1.15) (2026-09-20)


### Bug Fixes

* **suggest:** whole-word matching, rerank-ready search, and an optional measured Jev layer ([#54](https://github.com/The-Vibe-Company/granite/issues/54)) ([aaac172](https://github.com/The-Vibe-Company/granite/commit/aaac172b2827107e08e7c96fefbf47ff2ed2df2c))

## [0.1.14](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.13...granite-mem-v0.1.14) (2026-07-21)


### Features

* **web:** show only vault note types ([#50](https://github.com/The-Vibe-Company/Granite/issues/50)) ([3116b15](https://github.com/The-Vibe-Company/Granite/commit/3116b15807959a51465bff9d5f97642f2302a2fd))

## [0.1.13](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.12...granite-mem-v0.1.13) (2026-07-17)


### Bug Fixes

* **web:** preserve markdown renderer in production bundle ([#48](https://github.com/The-Vibe-Company/Granite/issues/48)) ([7b4cfbb](https://github.com/The-Vibe-Company/Granite/commit/7b4cfbbe8adff085d14e1155b9ed4a4b5cada70a))

## [0.1.12](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.11...granite-mem-v0.1.12) (2026-07-06)


### Features

* **deploy:** one-command serverless Granite on Fly.io Sprites ([#46](https://github.com/The-Vibe-Company/Granite/issues/46)) ([b4a3782](https://github.com/The-Vibe-Company/Granite/commit/b4a37825c1ef2287b2e260645d0b6237a82256e2))
* **mcp:** secure remote HTTP transport ([#45](https://github.com/The-Vibe-Company/Granite/issues/45)) ([987cf14](https://github.com/The-Vibe-Company/Granite/commit/987cf14d5f5d32aeafdc8429d77da2fae7e79ddd))


### Bug Fixes

* **cli:** derive version from package metadata ([#42](https://github.com/The-Vibe-Company/Granite/issues/42)) ([6efdadc](https://github.com/The-Vibe-Company/Granite/commit/6efdadc298321cc987f5ab9463101fe77575244d))
* **release:** publish granite-mem through trusted publishing ([#40](https://github.com/The-Vibe-Company/Granite/issues/40)) ([ab9ed2c](https://github.com/The-Vibe-Company/Granite/commit/ab9ed2cfb44f2059549eea80c830a717414c8cd3))
* **release:** publish npm without legacy token ([#43](https://github.com/The-Vibe-Company/Granite/issues/43)) ([fc4d3b7](https://github.com/The-Vibe-Company/Granite/commit/fc4d3b7223f233a42c7ea5d6ac80044867fa75c7))
* **release:** rely on npm trusted publishing ([bbe36e2](https://github.com/The-Vibe-Company/Granite/commit/bbe36e2116116ff7da023ab2e65980f2bd75a781))

## [0.1.11](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.10...granite-mem-v0.1.11) (2026-05-29)


### Features

* **sync:** add readonly vault access control ([#38](https://github.com/The-Vibe-Company/Granite/issues/38)) ([a326c42](https://github.com/The-Vibe-Company/Granite/commit/a326c42a9df1570b857622a2354338e44441dc05))

## [0.1.10](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.9...granite-mem-v0.1.10) (2026-05-28)


### Features

* **cloud:** add paid hosted vault platform ([#34](https://github.com/The-Vibe-Company/Granite/issues/34)) ([74c8532](https://github.com/The-Vibe-Company/Granite/commit/74c853268959b577d2fbc9e709aad96d5d8f5158))
* **cloud:** expose hosted private mcp endpoint ([#33](https://github.com/The-Vibe-Company/Granite/issues/33)) ([b80f2af](https://github.com/The-Vibe-Company/Granite/commit/b80f2afe0aae306e932abba87c33276fb3c63f4e))
* **cloud:** improve auth and API key dashboard ([#36](https://github.com/The-Vibe-Company/Granite/issues/36)) ([982e35b](https://github.com/The-Vibe-Company/Granite/commit/982e35be6206d1d4dadaf8dbc3ac2a9ceb1ef532))
* **sync:** add direct local vault sync ([c0d8483](https://github.com/The-Vibe-Company/Granite/commit/c0d8483cb5fa16db7a3a0495438990129aaa334a))

## [0.1.9](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.8...granite-mem-v0.1.9) (2026-04-24)


### Features

* add `granite wakeup` command + MCP tool ([085006d](https://github.com/The-Vibe-Company/Granite/commit/085006d97c46f42534939d04e046ed015ea05277))
* add asset attachments (images, videos, PDFs) ([0c310be](https://github.com/The-Vibe-Company/Granite/commit/0c310becec4ee62d624b5322ced30954d7f745a7))
* add deterministic garden planning ([b51f3a0](https://github.com/The-Vibe-Company/Granite/commit/b51f3a01e86df0c797310c2a0812d705fdc919b9))
* add document import and doc-aware MCP workflows ([7dc9c91](https://github.com/The-Vibe-Company/Granite/commit/7dc9c91a1cb3d01ddac8e62fb8bba0f55e490f65))
* add explicit document extraction ([572124e](https://github.com/The-Vibe-Company/Granite/commit/572124e20371f0e5219888e39c8e5c4b5d09ec69))
* add vault-garden skill + fix graph visualization ([ef81a88](https://github.com/The-Vibe-Company/Granite/commit/ef81a88fbb2cd9d798e17e0b34d38c0a7207b17e))
* commitzen ([0986ce8](https://github.com/The-Vibe-Company/Granite/commit/0986ce8daac7895ebaa9fceb651e83f11ab3295c))
* **conductor:** add turnkey config ([#30](https://github.com/The-Vibe-Company/Granite/issues/30)) ([31a9820](https://github.com/The-Vibe-Company/Granite/commit/31a9820720fd38b15206421698d9ffbf0737f287))
* **daemon:** unified background service for MCP + web UI ([5a9a6c5](https://github.com/The-Vibe-Company/Granite/commit/5a9a6c558cba12c3cbb6ba11737e4aacac723e5e))
* **garden:** add explicit opportunity adjudication ([95c07a3](https://github.com/The-Vibe-Company/Granite/commit/95c07a35d82b64c6333c848305e1273090aea17e))
* improve graph preview interactions ([0451074](https://github.com/The-Vibe-Company/Granite/commit/0451074d2430a34bc786c1b67ea374f817ea018f))
* **mcp:** expose vault type registry and enforce type contracts ([#28](https://github.com/The-Vibe-Company/Granite/issues/28)) ([2ca6330](https://github.com/The-Vibe-Company/Granite/commit/2ca6330517a4ac056883420bb45aeab2b1dfb48c))
* **query:** support cross-type filters when no type is passed ([9c951c9](https://github.com/The-Vibe-Company/Granite/commit/9c951c95fd20153d01820d2672c62540fafa4ac8))
* redesign graph visualization — monochrome, organic, spread-out ([09dc8d7](https://github.com/The-Vibe-Company/Granite/commit/09dc8d73ea569aaac436b3970f182ae1706838d0))
* refactor Granite MCP around workflow tools ([8a14c27](https://github.com/The-Vibe-Company/Granite/commit/8a14c27ec03afe6cb0dba9b89f173c5bb9c48d7f))
* refine graph atlas UX ([1574ade](https://github.com/The-Vibe-Company/Granite/commit/1574ade847506bb67148d97ac70cc862d8345f89))
* refine graph-first web ui ([e17b4b5](https://github.com/The-Vibe-Company/Granite/commit/e17b4b5eec439d5d40952aba6178b93a955eb7d0))
* store imported document content ([1d3cae1](https://github.com/The-Vibe-Company/Granite/commit/1d3cae1b915857ea53520dd0c1202bd8d0f7b484))
* tighten graph clustering ([f3df958](https://github.com/The-Vibe-Company/Granite/commit/f3df95893a31ba690831a1b2aa6400eefa8f9d04))
* **types:** active contracts with hooks, typed queries, compile context ([#27](https://github.com/The-Vibe-Company/Granite/issues/27)) ([94d32b5](https://github.com/The-Vibe-Company/Granite/commit/94d32b5d0a3e6bb4070ca3b2e8efe1a3fa1ba81b))
* **web:** constellation home with live graph + floating reader ([a316332](https://github.com/The-Vibe-Company/Granite/commit/a31633280ab5885bc7edb4dce9b304a2eca275d3))


### Bug Fixes

* better node size scaling in graph visualization ([4389fa3](https://github.com/The-Vibe-Company/Granite/commit/4389fa3f9c4884b63cb3e1768c120c8c0959a602))
* **daemon:** prefer default vault for daemon subcommands ([f102d0e](https://github.com/The-Vibe-Company/Granite/commit/f102d0e98d7e8815b51490bd4849a0522df85441))
* make index rebuild atomic ([1be56a5](https://github.com/The-Vibe-Company/Granite/commit/1be56a5d3546d9547ac0df862b862c82eddfb5d8))
* search uses OR instead of AND for multi-word queries ([f47ca42](https://github.com/The-Vibe-Company/Granite/commit/f47ca424600a9a215c5d1aa23306ea527a39f3d7))
* sync index after CLI edit/append so wikilinks are tracked ([1153c93](https://github.com/The-Vibe-Company/Granite/commit/1153c9312e8b1f3e95a19b627fd0cf08ef892fe5))
* **web:** type filters actually dim non-matching nodes ([3c75133](https://github.com/The-Vibe-Company/Granite/commit/3c751334f41fc3f88990a3f975adbc863d66522c))
* z.record needs two args in wakeup schema ([4180911](https://github.com/The-Vibe-Company/Granite/commit/4180911d6c750d9ebc93d1436b8fa2597a6dd265))


### Performance Improvements

* **web:** idle-skip main loop, minify assets, preload fonts ([644785f](https://github.com/The-Vibe-Company/Granite/commit/644785fe9a528cd5bb263320c0e5d59354e05ac6))

## [0.1.8](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.7...granite-mem-v0.1.8) (2026-04-04)


### Features

* add agent-friendly note protocol metadata ([#22](https://github.com/The-Vibe-Company/Granite/issues/22)) ([68b0527](https://github.com/The-Vibe-Company/Granite/commit/68b05277f55587fabb2b29aa05eadb95b5101dfa))
* redesign web UI with command palette, mobile nav, and accessibility ([2cb8a46](https://github.com/The-Vibe-Company/Granite/commit/2cb8a46c9b6998371051bd101437d3f6cc4f6296))
* remove sync, upgrade MCP server to knowledge compiler ([207794a](https://github.com/The-Vibe-Company/Granite/commit/207794a9f1c811663746b5c7beed9d54811e1e3f))
* split granite skill into loop-phase skills ([#25](https://github.com/The-Vibe-Company/Granite/issues/25)) ([f751d34](https://github.com/The-Vibe-Company/Granite/commit/f751d341bc26fc39b4b57077332ca22b87009d94))

## [0.1.7](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.6...granite-mem-v0.1.7) (2026-03-31)


### Features

* rename cli ([#20](https://github.com/The-Vibe-Company/Granite/issues/20)) ([14f194c](https://github.com/The-Vibe-Company/Granite/commit/14f194c6409ab207fa0b6983c2e8a2e50e5c8a41))

## [0.1.6](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.5...granite-mem-v0.1.6) (2026-03-31)


### Features

* rename mem skill to granite ([#18](https://github.com/The-Vibe-Company/Granite/issues/18)) ([9fd55e6](https://github.com/The-Vibe-Company/Granite/commit/9fd55e6cac13a95ee9ffb733d2cd28a05baf4615))

## [0.1.5](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.4...granite-mem-v0.1.5) (2026-03-31)


### Features

* multi-device sync system + Granite Cloud worker ([#15](https://github.com/The-Vibe-Company/Granite/issues/15)) ([e4126fb](https://github.com/The-Vibe-Company/Granite/commit/e4126fb42fd148b69eba1445aedf3f747139f28d))
* rename installed cli to granite ([#17](https://github.com/The-Vibe-Company/Granite/issues/17)) ([3fdba99](https://github.com/The-Vibe-Company/Granite/commit/3fdba99330478ab9c1b3639193932de724d6cebf))

## [0.1.4](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.3...granite-mem-v0.1.4) (2026-03-31)


### Features

* Add Granite MCP server ([#11](https://github.com/The-Vibe-Company/Granite/issues/11)) ([749010e](https://github.com/The-Vibe-Company/Granite/commit/749010e60452c4ee4e9e1ee8bd59a6b0fea5c6a5))


### Bug Fixes

* align release workflow with companion ([#13](https://github.com/The-Vibe-Company/Granite/issues/13)) ([717e55e](https://github.com/The-Vibe-Company/Granite/commit/717e55e10ab49caa1034a1b6ef967653a33bc992))
* harden CI and release-please workflow ([#12](https://github.com/The-Vibe-Company/Granite/issues/12)) ([94182cf](https://github.com/The-Vibe-Company/Granite/commit/94182cff781b8c87fa19653ce6f0b858e7d24658))

## [0.1.3](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.2...granite-mem-v0.1.3) (2026-03-30)


### Bug Fixes

* default vault location for mem init ([#9](https://github.com/The-Vibe-Company/Granite/issues/9)) ([7db715b](https://github.com/The-Vibe-Company/Granite/commit/7db715b1aa08bec582e845629bffc7178a921f19))

## [0.1.2](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.1...granite-mem-v0.1.2) (2026-03-30)


### Features

* add local note recommendations ([#6](https://github.com/The-Vibe-Company/Granite/issues/6)) ([51ce939](https://github.com/The-Vibe-Company/Granite/commit/51ce939c2078487d903d77aa9da8fe6f59aab566))


### Bug Fixes

* rebuild recommendations after durable note updates ([#8](https://github.com/The-Vibe-Company/Granite/issues/8)) ([2f4dff3](https://github.com/The-Vibe-Company/Granite/commit/2f4dff3ff2b59a897351c41fc9ec66a816c7fa30))

## [0.1.1](https://github.com/The-Vibe-Company/Granite/compare/granite-mem-v0.1.0...granite-mem-v0.1.1) (2026-03-30)


### Features

* add CI/CD pipeline with release-please and NPM publishing ([cd6afa1](https://github.com/The-Vibe-Company/Granite/commit/cd6afa1871f70d9a24aad1ce605ab829ba1fbdda))
* add CI/CD pipeline with release-please and NPM publishing ([cd6afa1](https://github.com/The-Vibe-Company/Granite/commit/cd6afa1871f70d9a24aad1ce605ab829ba1fbdda))
* add CI/CD pipeline with release-please and NPM publishing ([72468e1](https://github.com/The-Vibe-Company/Granite/commit/72468e16d6538bd159f1ea275b272ff31ebad4a3))
