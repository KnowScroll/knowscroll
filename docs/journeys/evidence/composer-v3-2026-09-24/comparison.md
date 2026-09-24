# Composer comparison (2026-09-24T02:47:07.452Z)

Library: 23 Scrolls; 20 deliberate steps per reader; no provider call.

| Reader | Policy | Keeps in 20 | Keeps in first 10 | All interest kept by step | Grounded in own acts | Domains touched | Adjacent same idea | Exhausted at step |
|---|---|---|---|---|---|---|---|---|
| sky reader | composer-signals-v2 | 11 | 4 | — | 0 | 4 | 0 | — |
| sky reader | composer-semantic-v3 | 12 | 8 (7–9) | — | 0.93 (0.9–0.95) | 4 | 0 | — |
| living-systems reader | composer-signals-v2 | 6 | 3 | 17 | 0 | 4 | 0 | — |
| living-systems reader | composer-semantic-v3 | 6 | 4.67 (2–6) | 11.33 (10–14) | 0.3 (0.25–0.35) | 4 | 0.67 (0–1) | — |
| watcher | composer-signals-v2 | 0 | 0 | — | 0 | 4 | 0 | — |
| watcher | composer-semantic-v3 | 0 | 0 | — | 0 | 4 | 0 | — |

## sky reader — composer-signals-v2 (first run)

1. ★ An orbit is not a perfect circle [astro.orbit.ellipse]
2. ★ A star is a balancing act [astro.star.equilibrium]
3. ★ An ordinary star with a big job [astro.sun]
4. The Moon tugs at the sea [earth.tides]
5. Tip the balance, shift the climate [earth.climate.energy_budget.equilibrium]
6. A rhythm the ocean keeps [earth.tides]
7. A blanket made of gas [earth.climate.greenhouse_effect]
8. A tilt that doesn't change [earth.seasons.axial_tilt]
9. Your body has a thermostat [bio.homeostasis.negative_feedback]
10. ★ Farther out, a longer year [astro.orbit.period_distance]
11. ★ The pressure that holds the Sun up [astro.sun.energy_output]
12. ★ Burn hot, live fast [astro.star.lifetime_mass]
13. ★ It isn't about distance [astro.orbit.distance]
14. Earth's energy has to balance [earth.climate.energy_budget.equilibrium]
15. ★ The pull you can't see [physics.gravity]
16. The Goldilocks temperature [earth.climate.greenhouse_effect]
17. When more becomes more [bio.homeostasis.positive_feedback]
18. ★ When the fuel runs out [astro.star.death]
19. ★ Halfway through a long life [astro.sun]
20. ★ A pull with a range [physics.gravity.mass_dependence]

## sky reader — composer-semantic-v3 (first run)

1. The Goldilocks temperature [earth.climate.greenhouse_effect · seed]
2. ★ An orbit is not a perfect circle [astro.orbit.ellipse · seed]
3. ★ The pull you can't see [physics.gravity · bridge]
4. ★ A pull with a range [physics.gravity.mass_dependence · bridge]
5. ★ A star is born from a cloud [astro.star.birth · bridge]
6. A rhythm the ocean keeps [earth.tides · bridge]
7. ★ Closest to the Sun in January [astro.orbit.distance · bridge]
8. ★ Farther out, a longer year [astro.orbit.period_distance · bridge]
9. ★ One force, many jobs [physics.gravity · bridge]
10. ★ The pressure that holds the Sun up [astro.sun.energy_output · deepen]
11. Your body has a thermostat [bio.homeostasis.negative_feedback · bridge]
12. Earth's energy has to balance [earth.climate.energy_budget.equilibrium · bridge]
13. ★ It isn't about distance [astro.orbit.distance · bridge]
14. A tilt that doesn't change [earth.seasons.axial_tilt · deepen]
15. ★ An ordinary star with a big job [astro.sun · continue]
16. A blanket made of gas [earth.climate.greenhouse_effect · bridge]
17. ★ A star is a balancing act [astro.star.equilibrium · deepen]
18. ★ Burn hot, live fast [astro.star.lifetime_mass · deepen]
19. Tip the balance, shift the climate [earth.climate.energy_budget.equilibrium · bridge]
20. The Moon tugs at the sea [earth.tides · bridge]

## living-systems reader — composer-signals-v2 (first run)

1. An orbit is not a perfect circle [astro.orbit.ellipse]
2. A star is a balancing act [astro.star.equilibrium]
3. An ordinary star with a big job [astro.sun]
4. The Moon tugs at the sea [earth.tides]
5. ★ Tip the balance, shift the climate [earth.climate.energy_budget.equilibrium]
6. A rhythm the ocean keeps [earth.tides]
7. ★ A blanket made of gas [earth.climate.greenhouse_effect]
8. A tilt that doesn't change [earth.seasons.axial_tilt]
9. ★ Your body has a thermostat [bio.homeostasis.negative_feedback]
10. Farther out, a longer year [astro.orbit.period_distance]
11. The pressure that holds the Sun up [astro.sun.energy_output]
12. Burn hot, live fast [astro.star.lifetime_mass]
13. It isn't about distance [astro.orbit.distance]
14. ★ Earth's energy has to balance [earth.climate.energy_budget.equilibrium]
15. The pull you can't see [physics.gravity]
16. ★ The Goldilocks temperature [earth.climate.greenhouse_effect]
17. ★ When more becomes more [bio.homeostasis.positive_feedback]
18. When the fuel runs out [astro.star.death]
19. Halfway through a long life [astro.sun]
20. A pull with a range [physics.gravity.mass_dependence]

## living-systems reader — composer-semantic-v3 (first run)

1. A star is a balancing act [astro.star.equilibrium · seed]
2. The pull you can't see [physics.gravity · seed]
3. A pull with a range [physics.gravity.mass_dependence · fallback]
4. ★ When more becomes more [bio.homeostasis.positive_feedback · seed]
5. ★ Your body has a thermostat [bio.homeostasis.negative_feedback · deepen]
6. ★ Tip the balance, shift the climate [earth.climate.energy_budget.equilibrium · bridge]
7. The pressure that holds the Sun up [astro.sun.energy_output · bridge]
8. ★ Earth's energy has to balance [earth.climate.energy_budget.equilibrium · bridge]
9. ★ A blanket made of gas [earth.climate.greenhouse_effect · deepen]
10. ★ The Goldilocks temperature [earth.climate.greenhouse_effect · deepen]
11. An orbit is not a perfect circle [astro.orbit.ellipse · frontier]
12. A tilt that doesn't change [earth.seasons.axial_tilt · frontier]
13. A rhythm the ocean keeps [earth.tides · frontier]
14. One force, many jobs [physics.gravity · fallback]
15. Halfway through a long life [astro.sun · fallback]
16. Burn hot, live fast [astro.star.lifetime_mass · fallback]
17. Farther out, a longer year [astro.orbit.period_distance · fallback]
18. An ordinary star with a big job [astro.sun · fallback]
19. The Moon tugs at the sea [earth.tides · fallback]
20. Closest to the Sun in January [astro.orbit.distance · fallback]

## watcher — composer-signals-v2 (first run)

1. An orbit is not a perfect circle [astro.orbit.ellipse]
2. A star is a balancing act [astro.star.equilibrium]
3. An ordinary star with a big job [astro.sun]
4. The Moon tugs at the sea [earth.tides]
5. Tip the balance, shift the climate [earth.climate.energy_budget.equilibrium]
6. A rhythm the ocean keeps [earth.tides]
7. A blanket made of gas [earth.climate.greenhouse_effect]
8. A tilt that doesn't change [earth.seasons.axial_tilt]
9. Your body has a thermostat [bio.homeostasis.negative_feedback]
10. Farther out, a longer year [astro.orbit.period_distance]
11. The pressure that holds the Sun up [astro.sun.energy_output]
12. Burn hot, live fast [astro.star.lifetime_mass]
13. It isn't about distance [astro.orbit.distance]
14. Earth's energy has to balance [earth.climate.energy_budget.equilibrium]
15. The pull you can't see [physics.gravity]
16. The Goldilocks temperature [earth.climate.greenhouse_effect]
17. When more becomes more [bio.homeostasis.positive_feedback]
18. When the fuel runs out [astro.star.death]
19. Halfway through a long life [astro.sun]
20. A pull with a range [physics.gravity.mass_dependence]

## watcher — composer-semantic-v3 (first run)

1. When more becomes more [bio.homeostasis.positive_feedback · seed]
2. Halfway through a long life [astro.sun · seed]
3. Burn hot, live fast [astro.star.lifetime_mass · fallback]
4. Closest to the Sun in January [astro.orbit.distance · seed]
5. A tilt that doesn't change [earth.seasons.axial_tilt · seed]
6. The pressure that holds the Sun up [astro.sun.energy_output · fallback]
7. One force, many jobs [physics.gravity · seed]
8. The Goldilocks temperature [earth.climate.greenhouse_effect · seed]
9. An ordinary star with a big job [astro.sun · fallback]
10. A rhythm the ocean keeps [earth.tides · seed]
11. It isn't about distance [astro.orbit.distance · fallback]
12. A pull with a range [physics.gravity.mass_dependence · fallback]
13. The pull you can't see [physics.gravity · fallback]
14. A blanket made of gas [earth.climate.greenhouse_effect · fallback]
15. A star is a balancing act [astro.star.equilibrium · fallback]
16. The Moon tugs at the sea [earth.tides · fallback]
17. Farther out, a longer year [astro.orbit.period_distance · fallback]
18. An orbit is not a perfect circle [astro.orbit.ellipse · fallback]
19. Your body has a thermostat [bio.homeostasis.negative_feedback · fallback]
20. A star is born from a cloud [astro.star.birth · fallback]

