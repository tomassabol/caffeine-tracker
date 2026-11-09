# Caffeine Curve

How much caffeine from coffee and matcha is still in you at bedtime. Next.js 16 + React Compiler.

```bash
bun install
bun run dev    # http://localhost:3000
bun test       # model checks
```

## The model

Each drink is a one-compartment model with first-order absorption and elimination
(the Bateman function), and drinks add up linearly:

```
amount(t) = dose · ka / (ka − ke) · (e^(−ke·t) − e^(−ka·t))
ke = ln 2 / half-life
ka = absorption rate, solved from "time to peak": ln(ka/ke) / (ka − ke) = tmax
```

The chart shows milligrams in the body, not plasma concentration. Bioavailability is
taken as 100%, since caffeine is absorbed rapidly and completely with negligible first-pass
metabolism.

`lib/model.test.ts` checks that the solved `ka` really peaks at the set time, that the area
under the curve equals `dose / ke`, that the level halves every half-life once absorbed, and
that doses add linearly.

## Defaults and where they come from

| Setting | Default | Basis |
| --- | --- | --- |
| Coffee per cup | 95 mg | USDA average for 8 oz brewed coffee; real cups run ~70–140 mg |
| Matcha per serving | 65 mg | 2 g of powder at ~32 mg/g; measured range 18.9–44.4 mg/g (Koláčková et al. 2020) |
| Time to peak | 45 min (both) | Coffee peaked at 42 ± 5 min in saliva (Liguori et al. 1997); general range 15–120 min |
| Half-life | 5 h | Mean in healthy adults; range ~1.5–9.5 h (shorter for smokers, longer on oral contraceptives or in pregnancy) |
| Sleep limit | 50 mg | Rule of thumb, not a clinical threshold. EFSA (2015): 100 mg close to bedtime may disturb sleep in some adults |

**Matcha and "slower" caffeine.** It is often claimed that L-theanine, catechins or the
whole leaf slow matcha's caffeine absorption. No human pharmacokinetic study comparing
matcha with coffee backs this up, so both drinks share the same default peak time. Matcha's
real difference here is the dose. Both peak times can be changed in settings.

## Known limitations

- Ignores caffeine left over from the previous day (with the defaults, about 20 mg at 06:00).
- Treats the half-life as fixed; real elimination varies with genetics (CYP1A2), smoking,
  medication, pregnancy and liver function.
- Not medical advice.

## Sources

- Liguori, Hughes & Grass (1997), *Absorption and subjective effects of caffeine from coffee, cola and capsules*, Pharmacol Biochem Behav. PMID 9329065
- Grzegorzewski et al. (2022), *Pharmacokinetics of caffeine: a systematic analysis of reported data*, Front. Pharmacol. doi:10.3389/fphar.2021.752826
- Institute of Medicine (2001), *Caffeine for the Sustainment of Mental Task Performance*, ch. 2 (NBK223808)
- Koláčková et al. (2020), *Matcha Tea: Analysis of Nutritional Composition, Phenolics and Antioxidant Activity*, Plant Foods Hum Nutr 75:48–53
- Kochman et al. (2020), *Health Benefits and Chemical Composition of Matcha Green Tea: A Review*, Molecules (PMC7796401)
- EFSA NDA Panel (2015), *Scientific Opinion on the safety of caffeine*, EFSA Journal doi:10.2903/j.efsa.2015.4102
