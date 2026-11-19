"""One DSH operation per process. Model calls and write grants come from the host."""
from __future__ import annotations
import json
import sys
import logging
from pathlib import Path
from wiki_core.retrieval import WikiRepository, WikiSettings, WikiAccessError
from wiki_core.consolidate import Consolidator, WikiLock
from wiki_core.extract import extract_batch

logging.disable(logging.CRITICAL)  # Do not put source text or provider errors on stderr.
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')


def exchange(kind, **values):
    print(json.dumps({'type': kind, **values}, ensure_ascii=False), flush=True)
    answer = json.loads(sys.stdin.readline())
    if not answer.get('ok'):
        raise WikiAccessError('host-denied' if kind == 'authorize' else 'model-unavailable')
    return answer.get('value')


def main(request):
    config = request['config']
    settings = WikiSettings(profile_root=Path(config['root']).parent, wiki_path=Path(config['root']),
                            profile_name=config['profile'], propose_enabled=True, auto_capture=True,
                            consolidate='on', max_chars=config.get('maxChars', 5000))

    class Repository(WikiRepository):
        def write_text(self, *args, **kwargs):
            exchange('authorize')
            return super().write_text(*args, **kwargs)

        def remove_file(self, *args, **kwargs):
            exchange('authorize')
            return super().remove_file(*args, **kwargs)

        def update_candidate_metadata(self, *args, **kwargs):
            exchange('authorize')
            return super().update_candidate_metadata(*args, **kwargs)

        def append_log(self, *args, **kwargs):
            exchange('authorize')
            return super().append_log(*args, **kwargs)

        def propose(self, **kwargs):
            exchange('authorize')
            return super().propose(**kwargs)

    repo = Repository(settings)
    complete = lambda task, system, user, max_tokens: exchange('llm', task=task, system=system, user=user, maxTokens=max_tokens)
    consolidator = Consolidator(repo, complete)
    action, args = request['action'], request.get('args', {})
    reviewer = 'dsh:' + settings.profile_name
    if action == 'extract':
        result = extract_batch(repo, complete, args['entries'], provenance=args['provenance'])
        return {'success': True, 'candidates': result}
    if action == 'consolidate':
        exchange('authorize')
        return consolidator.run(dry_run=args.get('dryRun', False), limit=args.get('limit', 10), candidate_ids=args.get('candidateIds'))
    if action == 'propose':
        return repo.propose(title=args['title'], content=args['content'], reason='User requested memory',
                            provenance=args.get('provenance', {}), facets={'kind': 'fact', 'confidence': .95, 'scope': f'profile:{settings.profile_name}'})
    if action == 'review':
        if args.get('action', 'list') == 'list':
            return {'success': True, 'candidates': repo.list_candidates(review_status=args.get('status', 'needs_review'), limit=args.get('limit', 20))}
        exchange('authorize')
        if args['action'] == 'approve':
            return consolidator.approve(args['candidateId'], reviewer=reviewer)
        if args['action'] == 'reject':
            return repo.review_candidate(candidate_id=args['candidateId'], action='reject', reviewer=reviewer)
        if args['action'] == 'replan':
            candidate = repo.find_candidate(args['candidateId'])
            if candidate.metadata.get('review_status', 'pending') != 'pending':
                raise WikiAccessError('only pending candidates can be replanned')
            repo.update_candidate_metadata(args['candidateId'], {'consolidation_state': '', 'proposed_plan': None, 'consolidation_attempts': 0})
            return consolidator.run(candidate_ids=[args['candidateId']])
        raise ValueError('invalid review action')
    if action == 'undo':
        exchange('authorize')
        return consolidator.undo(args['changeId'], reviewer=reviewer)
    if action == 'status':
        return {**repo.status(), 'automation': consolidator.automation_status()}
    if action == 'maintenance':
        exchange('authorize')
        with WikiLock(consolidator.root) as lock:
            if not lock.acquire():
                raise WikiAccessError('another writer is active')
            consolidator.recover()
        return {'success': True, 'lint': consolidator.lint(), 'digest': consolidator.digest(force=args.get('force', False))}
    raise ValueError('unknown action')


if __name__ == '__main__':
    try:
        value = main(json.loads(sys.stdin.readline()))
        print(json.dumps({'type': 'result', 'ok': True, 'value': value}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({'type': 'result', 'ok': False, 'error': type(error).__name__}), flush=True)
