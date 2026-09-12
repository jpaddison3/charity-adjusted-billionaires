# Charity-adjusted wealth methodology

The committed output is a retrospective **December 31, 2025 snapshot**, not a real-time estimate. Publication is roughly eight months after the valuation date. Inputs preserve observation, publication, retrieval, and valuation dates separately.

## Definition

For donor $d$ and snapshot $T$, charity-adjusted wealth is

$$
W_d(T) + \sum_g A_g C_{g,d}\frac{I(T)}{I(t_g)},
$$

where $W_d(T)$ is the eligible wealth observation carried unchanged to the snapshot, $A_g$ is the transfer-time dollar amount, $C_{g,d}$ is the donor's credit share, and $I$ is the saved S&P 500 cumulative total-return series. This asks what the donor's completed charitable transfers would be worth if invested in the dividend-reinvesting market series. It is not a claim about how the recipient invested the gift.

Inflation-adjusted giving is reported separately:

$$
\sum_g A_g C_{g,d}\frac{\operatorname{CPI}(T)}{\operatorname{CPI}(t_g)}.
$$

It is not added to wealth. Calculations retain JavaScript numeric precision; exported dollar values are rounded to cents. Ranking uses unrounded charity-adjusted wealth and breaks ties by donor ID.

## Dates and alignment

The transfer ledger preserves the seed date, assessed precision, and calculation date. Day-precision transfers retain dates supported by cited SEC transactions or reconciled major-transfer filings. Unverified seed dates use a provisional calendar-year estimate; the seed's numeric month and day do not establish precision. A month, calendar year, or explicitly bounded fiscal reporting period uses the earlier middle UTC calendar day: `start + floor((daysInPeriod - 1) / 2)`. The generator validates that the calculation date matches the declared precision and period. Unallocatable multi-year totals have null calculation dates and are excluded, with their original amounts and related records retained as unresolved references. Those references may overlap and must not be summed as additional giving. Transfers after the snapshot remain visible with an `after-snapshot` exclusion reason derived from their calculation date.

Market observations are exact December 31 cumulative values from Damodaran's S&P 500 series including dividends. For a date between endpoints $a$ and $b$:

$$
I(t)=I(a)\left(\frac{I(b)}{I(a)}\right)^{(t-a)/(b-a)}.
$$

The exponent uses UTC calendar-day differences, including weekends and leap days. This is uniform compounded interpolation, not observed daily market performance. Missing endpoints or extrapolation fail generation.

The extract follows the saved official HTML table labeled January 5, 2026, including the 2025 endpoint of 1,157,598.95. The later downloaded workbook reports 1,157,009.0876078464 instead. Both source versions are retained and identified separately; the workbook is not the authority for the chosen 2025 endpoint.

CPI-U uses the gift's calendar month and December 2025 for $T$. FRED/BLS has no October 2025 observation, so the saved value is the explicitly labeled arithmetic mean of September and November: $(324.800 + 324.122)/2 = 324.461$. Every transfer using that month is labeled in the export. Any other missing month, or a missing snapshot month, aborts generation.

## Transfers and reconciliation

The raw donation loader returns one economic event with its complete credit map, source location, row locator, and semantic SHA-256 fingerprint. `data/lcb/inputs/transfers.json` gives every active seed event an inclusion decision. Missing dispositions, stale fingerprints, unknown donors, and duplicate transfer identities within a funding chain fail generation.

Only completed irrevocable personal transfers into charities, foundations, or donor-advised funds count. Pledges, downstream grants from a funded vehicle, inter-vehicle movements, political giving, and noncharitable investments do not. Excluding one donor does not redistribute their credit share. Unresolved totals are disclosed in coverage rather than added.

The material reconciliation replaced Warren Buffett's five pledge-era cumulative estimates with annual 2006–2025 share transfers, removed bidder-funded GLIDE auction proceeds, and retained distinct later supplements. Gates Foundation Trust audited fair values anchor Gates-recipient amounts; other Buffett-family foundation amounts are identified as share-ratio estimates where recipient fair value was unavailable.

For Bill and Melinda Gates, foundation inflows remain but downstream UNCF, Gavi, university, and library distributions were removed. Each removed Pivotal announcement has a separate evidence assessment: the May 2024 program and Action for Women's Health concern foundation grantmaking; the conditional matching offers and Wellcome Leap partnership remain unresolved rather than being assumed to be completed personal gifts. None of these exclusions establishes that Bill's October contributions funded the announcements. The 2004 planned transfer and inferred 2025 rounded delta are unresolved rather than counted. Filed values replace the 2017 and 2022 estimates. Four October 2024 Pivotal Schedule B transfers are separate legal transfers; the commitment remainder stays unresolved. Full arithmetic, source links, and removed records are in `data/lcb/inputs/reconciliation.json`.

## Wealth and coverage

Donor IDs join explicitly to wealth profile IDs. The preferred input is the latest dated individual observation on or before the snapshot within 2025, carried forward unchanged and with its lag disclosed. No S&P growth is applied to wealth. Post-snapshot observations and undated donor-frontmatter `netWorth` values are never used.

**Wealth/giving overlap rule:** This prototype carries that observation forward without subtracting subsequent gifts or estimating intervening investment returns. A gift made after the wealth observation can therefore appear in both the stale wealth estimate and the giving term. The sum is an approximation with potential overlap, not a reconstructed year-end balance sheet. The same rule applies when a provisional year/month midpoint falls after the wealth observation; that midpoint is not evidence that the actual gift occurred afterward. We do not infer a nominal wealth deduction from an uncertain date. The dated wealth-record reference allows consumers to assess this limitation, which can materially affect rankings for donors making large gifts later in 2025.

Forbes's March 7, 2025 list supplies most observations through a [third-party transcription by FilesUploader](https://github.com/FilesUploader/Forbes-Billionaire-List/commit/7245d285eeecc3999cf772aa47b276ffe2fb8e3d). The source manifest pins the byte-identical download to that commit and distinguishes the transcription's publication from Forbes's official date and methodology. Dated alternatives cover four people absent from that list. Dustin Moskovitz/Cari Tuna, Steve/Connie Ballmer, and John/Laura Arnold are unranked because the evidence identifies shared wealth pools without defensible individual allocations. Missing or unusable wealth stays null. A matched donor without supported giving retains known wealth, but all giving totals, charity-adjusted wealth, and rank are null.

All current histories are marked partial: the ledger covers every seed event, but many dates retain provisional year estimates and deeper source reconciliation remains bounded. Multi-year aggregates, including the Bloomberg lifetime lump, Scott's cumulative giving, Soros's unsupported annual allocations, and the unsupported Sainsbury, Dangote, Plattner, and Huang timing estimates, are excluded from compounding. The Bezos Earth Fund and Day One commitments and Bloomberg's blended annual spending are also excluded pending evidence of completed personal transfers. Billi Marcus's family wealth is unranked without an individual allocation.

`coverage.json` reports active and excluded files, event counts, future transfers, wealth status, and unresolved references; `transfers.json` supplies every event's decision and reason. Named funding vehicles connect their inflows to downstream distributions, which never receive additional personal-giving credit. Unresolved overlap links resolve to transfer fingerprints or documented reference groups. Population counts are derived from the inputs.

Both ranking formats include the snapshot date and a wealth-record reference keyed by donor ID in `inputs/wealth.json`; that record contains the dated observation, source ID, snapshot estimate, and estimation method. Matched observations must fall within the snapshot year and on or before its date. Duplicate donor records, inconsistent input snapshots, unsupported carried-forward estimates, and inconsistent shared-pool allocations fail generation.

Ranking rows also link to donor-related unresolved-balance IDs in `coverage.json`; CSV encodes that list as a JSON array. These expose known gaps separately from the general partial-history flag. References can overlap and must not be summed. Reporting periods extending beyond the snapshot are excluded even when their midpoint precedes it. Economic duplicate identities are independent of donor credits; independently documented parallel gifts need distinct explicit identities.

Every unresolved balance explicitly lists the active donor profiles to which the uncertainty relates. This association takes precedence over overlap links, which can point to a different person's transfers or an unallocated reference group. For unattributed household receipts, listing both candidate profiles identifies the uncertainty; it does not allocate that money or add it to either total. Unknown or missing donor mappings and stale source fingerprints fail generation.

The source manifest saves and hashes the material replacement evidence as full document text or HTML, retaining retrieval metadata and original-document hashes where available. A source without saved evidence must explicitly record null paths/hashes and an unavailable reason. Such remote-only citations remain a disclosed offline-audit limitation.

## Reproducing the snapshot

No network access is used during generation.

1. Install locked dependencies with `npm ci`.
2. Run `npm run generate-data` to validate the content dataset.
3. Run `npm run generate-lcb-data` to write the four committed exports.
4. Run `npm run check-lcb-data` to regenerate in memory and byte-compare every export.
5. Run the focused tests, lint, coverage suite, and build as described in the repository README.

When donation content changes, the transfer fingerprint changes; update its explicit ledger disposition before regenerating. When a saved raw source changes, update its recorded SHA-256 and provenance deliberately.
