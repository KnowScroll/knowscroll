# Composer comparison (2026-09-24T03:42:32.679Z)

Library: 23 Scrolls; 20 deliberate steps per reader; no provider call.

| Reader | Policy | Keeps in 20 | Keeps in first 10 | All interest kept by step | Grounded in own acts | Domains touched | Adjacent same idea | Exhausted at step |
|---|---|---|---|---|---|---|---|---|
| sky reader | composer-signals-v2 | 11 | 4 | — | 0 | 4 | 0 | — |
| sky reader | composer-semantic-v3 | 12 | 8 | — | 0.92 (0.9–0.95) | 4 | 0 | — |
| living-systems reader | composer-signals-v2 | 6 | 3 | 17 | 0 | 4 | 0 | — |
| living-systems reader | composer-semantic-v3 | 6 | 2.67 (2–3) | 14 | 0.28 (0.25–0.3) | 4 | 0.33 (0–1) | — |
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

1. When more becomes more [bio.homeostasis.positive_feedback · seed]
2. ★ An orbit is not a perfect circle [astro.orbit.ellipse · seed]
3. ★ The pull you can't see [physics.gravity · bridge]
4. ★ A pull with a range [physics.gravity.mass_dependence · bridge]
5. ★ Closest to the Sun in January [astro.orbit.distance · bridge]
6. A rhythm the ocean keeps [earth.tides · bridge]
7. ★ A star is born from a cloud [astro.star.birth · bridge]
8. ★ Farther out, a longer year [astro.orbit.period_distance · bridge]
9. ★ One force, many jobs [physics.gravity · bridge]
10. ★ The pressure that holds the Sun up [astro.sun.energy_output · deepen]
11. Your body has a thermostat [bio.homeostasis.negative_feedback · bridge]
12. The Goldilocks temperature [earth.climate.greenhouse_effect · bridge]
13. Tip the balance, shift the climate [earth.climate.energy_budget.equilibrium · bridge]
14. ★ It isn't about distance [astro.orbit.distance · bridge]
15. A tilt that doesn't change [earth.seasons.axial_tilt · deepen]
16. ★ An ordinary star with a big job [astro.sun · continue]
17. The Moon tugs at the sea [earth.tides · bridge]
18. ★ A star is a balancing act [astro.star.equilibrium · deepen]
19. ★ Burn hot, live fast [astro.star.lifetime_mass · deepen]
20. A blanket made of gas [earth.climate.greenhouse_effect · bridge]

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
4. Closest to the Sun in January [astro.orbit.distance · seed]
5. A tilt that doesn't change [earth.seasons.axial_tilt · seed]
6. One force, many jobs [physics.gravity · fallback]
7. A rhythm the ocean keeps [earth.tides · seed]
8. ★ Earth's energy has to balance [earth.climate.energy_budget.equilibrium · seed]
9. The pressure that holds the Sun up [astro.sun.energy_output · bridge]
10. ★ Your body has a thermostat [bio.homeostasis.negative_feedback · bridge]
11. ★ Tip the balance, shift the climate [earth.climate.energy_budget.equilibrium · bridge]
12. ★ A blanket made of gas [earth.climate.greenhouse_effect · deepen]
13. ★ When more becomes more [bio.homeostasis.positive_feedback · deepen]
14. ★ The Goldilocks temperature [earth.climate.greenhouse_effect · fallback]
15. It isn't about distance [astro.orbit.distance · fallback]
16. The Moon tugs at the sea [earth.tides · fallback]
17. Farther out, a longer year [astro.orbit.period_distance · fallback]
18. Halfway through a long life [astro.sun · fallback]
19. Burn hot, live fast [astro.star.lifetime_mass · fallback]
20. An orbit is not a perfect circle [astro.orbit.ellipse · fallback]

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
2. A star is born from a cloud [astro.star.birth · seed]
3. The pull you can't see [physics.gravity · fallback]
4. The Goldilocks temperature [earth.climate.greenhouse_effect · seed]
5. It isn't about distance [astro.orbit.distance · seed]
6. A pull with a range [physics.gravity.mass_dependence · fallback]
7. A tilt that doesn't change [earth.seasons.axial_tilt · seed]
8. A rhythm the ocean keeps [earth.tides · seed]
9. One force, many jobs [physics.gravity · fallback]
10. A blanket made of gas [earth.climate.greenhouse_effect · fallback]
11. Closest to the Sun in January [astro.orbit.distance · fallback]
12. An orbit is not a perfect circle [astro.orbit.ellipse · fallback]
13. Halfway through a long life [astro.sun · fallback]
14. The Moon tugs at the sea [earth.tides · fallback]
15. The pressure that holds the Sun up [astro.sun.energy_output · fallback]
16. A star is a balancing act [astro.star.equilibrium · fallback]
17. Burn hot, live fast [astro.star.lifetime_mass · fallback]
18. Your body has a thermostat [bio.homeostasis.negative_feedback · fallback]
19. An ordinary star with a big job [astro.sun · fallback]
20. Farther out, a longer year [astro.orbit.period_distance · fallback]

