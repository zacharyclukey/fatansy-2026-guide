"""Plain-English scouting notes and draft calls.

Everything here is written so that someone who has never played fantasy football can
read one sentence and know whether to take the player. No jargon without explanation.
"""

POS_WORD = {'QB': 'quarterback', 'RB': 'running back', 'WR': 'wide receiver',
            'TE': 'tight end', 'K': 'kicker', 'DEF': 'defense'}


def scouting_note(p, lname, teams):
    """Why this player is where he is - in one or two plain sentences."""
    L, bits = p[lname], []
    pos, pr = p['pos'], L['posrank']

    if pos == 'DEF':
        return (f"Projected as the #{pr} defense. Defenses are nearly interchangeable - "
                f"take one in the last two rounds and stream matchups after that.")
    if pos == 'K':
        return (f"Projected as the #{pr} kicker. Kickers are a coin flip year to year. "
                f"Take one with your very last pick.")

    bits.append(f"Projected {pos}{pr} ({L['pts']:.0f} points this season).")

    # What last year actually looked like - the credibility check.
    if p.get('a_pts') and p.get('a_gp'):
        gp, ppg = p['a_gp'], p['a_pts'] / max(p['a_gp'], 1)
        if gp < 12:
            bits.append(f"Only played {gp:.0f} games last year, so there is real injury risk.")
        elif p.get('a_posrank'):
            bits.append(f"Finished {pos}{p['a_posrank']:.0f} last season at "
                        f"{ppg:.1f} points a game.")
    elif p.get('exp') == 0:
        bits.append("Rookie - no NFL track record yet, so this is a projection, not a proven result.")
    elif not p.get('a_pts'):
        bits.append("Little or no production last season, so the projection is the whole case for him.")

    # Usage - the single best predictor of fantasy points.
    if pos in ('WR', 'TE') and p.get('a_tgt'):
        bits.append(f"Was thrown at {p['a_tgt']:.0f} times last year"
                    + (f", including {p['a_rztgt']:.0f} near the goal line."
                       if p.get('a_rztgt') else "."))
    if pos == 'RB' and p.get('a_carries'):
        bits.append(f"Carried the ball {p['a_carries']:.0f} times last year.")

    if p['inj']:
        part = f" ({p['inj_part'].lower()})" if p['inj_part'] else ""
        bits.append(f"Currently listed as {p['inj'].lower()}{part} - check his status before the draft.")

    return " ".join(bits)


def hs_edge_note(p):
    """Why this player is worth more or less in the Highest Scorer league specifically."""
    fd = p.get('a_fd') or 0
    if p['pos'] in ('K', 'DEF'):
        return ""
    if fd >= 75:
        return (f"Moved the chains {fd:.0f} times last year - this league pays 0.1 per first "
                f"down, so he is worth more here than in a normal league.")
    if fd >= 45:
        return f"Picked up {fd:.0f} first downs last year, which is worth extra in this league."
    return ""


def draft_call(p, lname, teams, posture='balanced'):
    """The take/pass verdict, adjusted for what round we are in.
    Early rounds reward safety; later rounds reward upside."""
    L = p[lname]
    rnd, edge, tier = L['round'], L['edge'], L['tier']

    if p['pos'] in ('K', 'DEF'):
        return "Wait. Last two rounds."

    # Early rounds (1-4): protect the floor, punish reaches.
    if rnd <= 4:
        if tier == 1:
            return "ELITE - take him without thinking."
        if edge >= teams:
            return "STRONG VALUE - he is lasting about a round longer than he should."
        if edge <= -teams * 1.5:
            return "REACH - others take him early; you can likely find similar value later."
        return "SOLID - safe, productive pick at this spot."

    # Middle rounds (5-9): straight value.
    if rnd <= 9:
        if edge >= teams * 1.5:
            return "GREAT VALUE - clearly the best player available here."
        if edge >= teams * 0.5:
            return "GOOD VALUE - worth taking now."
        if edge <= -teams:
            return "SLIGHT REACH - fine if you need the position, otherwise wait."
        return "FAIR - reasonable pick, no bargain."

    # Late rounds (10+): swing for upside.
    if edge >= teams:
        return "UPSIDE SWING - great price, this is the round to gamble."
    if p.get('exp') is not None and p['exp'] <= 1:
        return "UPSIDE SWING - young, could break out."
    if p['inj']:
        return "LOTTERY TICKET - injury risk, but the cost is low."
    return "DEPTH - fills out your bench."


def roster_advice(lname, cfg):
    """League-specific roster-construction guidance shown on each board."""
    teams = cfg['teams']
    if teams >= 18:
        return ("18 TEAMS - the deepest league by far. Running backs dry up fastest: after "
                "roughly the 50th RB there is nothing usable left, so take them earlier and "
                "more often than feels normal. But do NOT take more than 4-5 in a row - you "
                "can only start 2 RBs plus 2 flex, and you still need a QB, a TE and receivers. "
                "There is no kicker or defense here, so every pick is a real player.")
    if lname == '1812 Highest Scorer':
        return ("12 teams. First downs and 40+ yard plays score here, which quietly favors "
                "high-volume possession receivers and every-down running backs over deep "
                "threats. Kickers matter more than usual (field goals score by distance and "
                "misses hurt), so do not punt the position entirely.")
    return ("12 teams, standard full PPR. Best player available early, then fill needs. "
            "Kicker and defense in the last two rounds - never earlier.")
