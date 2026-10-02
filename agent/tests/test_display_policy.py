from jobmatch.display import apply_display_policy


def transform(score, decision, conclusion='pending'):
    summary = {'positions': [{'id': 'role', 'grade': 'C', 'decision': decision,
        'registerable': False, 'evidence_match_percent': score, 'evidence_match_range': '55-60%'}]}
    record = {'positions': [{'id': 'role', 'excluded': decision == 'excluded', 'requirements': [
        {'category': 'hard_qualification', 'conclusion': conclusion}]}]}
    return summary, apply_display_policy(summary, record)['positions'][0]


def test_transferable_consider_is_adjacent_without_increasing_score():
    old, item = transform(56.5, 'consider', 'satisfied')
    assert item['grade'] == 'B' and item['evidence_match_percent'] == 56.5
    assert item['evidence_match_range'] == '55-60%' and old['positions'][0]['grade'] == 'C'


def test_unknown_qualification_does_not_become_weak_related_or_ready():
    _, item = transform(80, 'pending')
    assert item['grade'] == 'A' and item['decision'] == 'pending' and item['registerable'] is False


def test_actual_failed_qualification_stays_excluded_even_with_high_score():
    _, item = transform(80, 'excluded', 'not_satisfied')
    assert item['grade'] == 'C' and item['decision'] == 'excluded'
