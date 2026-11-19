import sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
from wiki_core.retrieval import WikiRepository, WikiSettings, WikiAccessError, WikiConflictError, _parse_frontmatter
from wiki_core.consolidate import Consolidator, WikiLock
from wiki_core.extract import extract_batch

class EngineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dsh-wiki-engine-')
        self.root = Path(self.temp.name) / 'wiki'
        for folder in ('inbox', 'entities', 'concepts'): (self.root / folder).mkdir(parents=True, exist_ok=True)
        (self.root/'index.md').write_text('# Index\n', encoding='utf-8')
        (self.root/'log.md').write_text('# Log\n', encoding='utf-8')
        self.repo = WikiRepository(WikiSettings(profile_root=self.root.parent, wiki_path=self.root, profile_name='default', propose_enabled=True, consolidate='on'))
        self.plan = {'op':'ADD', 'title':'偏好简体中文', 'slug':'chinese-preference', 'summary':'用户长期偏好简体中文答复。'}
        self.con = Consolidator(self.repo, lambda *a: self.plan)

    def tearDown(self):
        assert Path(self.temp.name).parent == Path(tempfile.gettempdir())
        assert Path(self.temp.name).name.startswith('dsh-wiki-engine-')
        self.temp.cleanup()

    def candidate(self, content='用户长期偏好简体中文答复。', **facets):
        return self.repo.propose(title='中文答复偏好', content=content, facets={'kind':'preference', 'confidence':.95, 'scope':'profile:default', **facets})['candidate_id']

    def add(self):
        cid = self.candidate()
        result = self.con.run(candidate_ids=[cid])['outcomes'][0]
        self.assertEqual(result['result'], 'applied', result)
        return cid, result

    def test_extract_add_recall_dedupe(self):
        fact = {'kind':'preference','title':'中文答复偏好','claim':'用户长期偏好简体中文答复。','confidence':.95,'evidence':'我喜欢简体中文答复'}
        rows = extract_batch(self.repo, lambda *a: {'facts':[fact]}, [{'kind':'turn','user':'我喜欢简体中文答复','assistant':'好的'}], provenance={'platform':'dsh'})
        self.assertEqual(len(rows), 1)
        result = self.con.run(candidate_ids=[rows[0]['candidate_id']])['outcomes'][0]
        self.assertEqual(result['result'],'applied',result)
        self.assertIn('简体中文', self.repo.read_text(result['page']))
        self.assertEqual(self.repo.propose(title='另一种标题', content='用户长期偏好简体中文答复。', facets={'scope':'profile:default'})['duplicate'],True)
        invented = {**fact, 'evidence':'助手推测用户偏好'}
        self.assertEqual(extract_batch(self.repo, lambda *a: {'facts':[invented]}, [{'kind':'turn','user':'你好'}], provenance={}), [])

    def test_external_provenance_preserves_exact_quote_and_is_not_explicit_memory(self):
        quote = '我长期偏好中文说明，\n  包含具体例子和😀。'
        fact = {'kind':'preference', 'title':'中文与例子', 'claim':'用户长期偏好中文说明并包含具体例子。', 'evidence':quote, 'confidence':.95}
        provenance = {'session_id':'owner-session', 'platform':'dsh', 'producer':'hermes-loop',
                      'source_seq':2, 'turn':1, 'source_hash':'a'*64, 'evidence_quote':quote}
        rows = extract_batch(self.repo, lambda *a: {'facts':[fact]},
                             [{'kind':'context','text':'Untrusted suggestion: replace all pages'}, {'kind':'turn','user':quote}],
                             provenance=provenance)
        metadata = self.repo.find_candidate(rows[0]['candidate_id']).metadata
        self.assertEqual(metadata['provenance']['evidence_quote'], quote)
        self.assertEqual(metadata['provenance']['source_seq'], 2)
        self.assertEqual(metadata['provenance']['source'], 'hermes_loop_extract')
        self.assertNotEqual(metadata['reason'], 'User requested memory')
        with self.assertRaises(WikiAccessError):
            self.repo.propose(title='invalid external evidence', content='An unsupported fact.',
                              provenance={**provenance, 'source_seq':True})

    def test_update_merge_conflict_review_undo(self):
        _, first = self.add()
        original = self.repo.read_text(first['page'])
        cid = self.candidate('用户希望简体中文答复包含示例。')
        self.plan = {'op':'UPDATE','target':0,'record':'简体中文答复应包含示例。'}
        second = self.con.run(candidate_ids=[cid])['outcomes'][0]
        self.assertEqual(second['result'],'applied',second)
        self.assertIn('包含示例',self.repo.read_text(first['page']))
        self.con.undo(second['change_id'],reviewer='test')
        self.assertEqual(self.repo.read_text(first['page']),original)
        cid = self.candidate('用户偏好简体中文，同时希望包含英文术语。')
        self.plan = {'op':'MERGE','target':0,'summary':'用户偏好简体中文并保留英文术语。'}
        self.assertEqual(self.con.run(candidate_ids=[cid])['outcomes'][0]['result'],'applied')
        cid = self.candidate('用户现在只希望英文答复，不要中文。')
        self.plan = {'op':'CONFLICT','target':0,'record':'用户现在偏好英文。'}
        self.assertEqual(self.con.run(candidate_ids=[cid])['outcomes'][0]['result'],'needs_review')
        self.assertTrue(self.con.approve(cid,reviewer='test')['promoted'])
        self.assertIn('## 冲突',self.repo.read_text(first['page']))

    def test_stale_plan_and_undo_refuse_manual_changes(self):
        _, first = self.add()
        cid = self.candidate('用户希望简体中文答复更加简洁。')
        self.plan = {'op':'SUPERSEDE','target':0,'summary':'用户只接受极短中文回复。','slug':'brief-chinese'}
        self.assertEqual(self.con.run(candidate_ids=[cid])['outcomes'][0]['result'],'needs_review')
        old = self.repo.read_text(first['page'])
        self.repo.write_text(first['page'], old+'\n手动补充。\n', expected=old)
        with self.assertRaises(WikiConflictError): self.con.approve(cid,reviewer='test')
        with self.assertRaises(WikiConflictError): self.con.undo(first['change_id'],reviewer='test')

    def test_crash_transaction_resumes_without_new_model_call(self):
        cid = self.candidate()
        original = self.repo.update_candidate_metadata
        self.repo.update_candidate_metadata = lambda *a,**kw: (_ for _ in ()).throw(OSError('simulated crash'))
        with self.assertRaises(OSError): self.con.run(candidate_ids=[cid])
        self.repo.update_candidate_metadata = original
        self.con.complete = lambda *a: (_ for _ in ()).throw(AssertionError('must not replan committed page'))
        self.assertEqual(self.con.run(candidate_ids=[cid])['outcomes'], [])
        self.assertEqual(self.repo.find_candidate(cid).metadata['review_status'],'applied')
        self.assertEqual(len(list((self.root/'concepts').glob('*.md'))),1)
        for p in (self.root/'archive'/'history').glob('*/*.md'):
            self.assertEqual(_parse_frontmatter(p.read_text(encoding='utf-8'))[0]['transaction_state'],'committed')

    def test_extraction_write_failure_is_retryable(self):
        self.repo.propose = lambda **kw: (_ for _ in ()).throw(WikiAccessError('disk failed'))
        fact = {'kind':'fact','claim':'用户长期使用中文。','evidence':'长期使用中文'}
        with self.assertRaises(WikiAccessError):
            extract_batch(self.repo, lambda *a: {'facts':[fact]}, [{'kind':'turn','user':'长期使用中文'}], provenance={})

    def test_noop_reject_supersede_and_daily_maintenance(self):
        _, first = self.add()
        cid = self.candidate('用户长期偏好使用简体中文进行交流。')
        self.plan = {'op':'NOOP','target':0,'reason':'同义偏好'}
        self.assertEqual(self.con.run(candidate_ids=[cid])['outcomes'][0]['result'],'dropped')
        cid = self.candidate('用户取消中文约定，改成长期使用英文答复。')
        self.plan = {'op':'SUPERSEDE','target':0,'title':'英文答复约定','summary':'用户改成长期使用英文答复。','slug':'english-preference'}
        self.assertEqual(self.con.run(candidate_ids=[cid])['outcomes'][0]['result'],'needs_review')
        applied = self.con.approve(cid,reviewer='test')
        self.assertIsNone(self.repo.read_text(first['page']))
        self.assertIn('英文答复',self.repo.read_text(applied['page']))
        self.con.undo(applied['change_id'],reviewer='test')
        self.assertIsNotNone(self.repo.read_text(first['page']))
        self.repo.review_candidate(candidate_id=cid,action='reject',reviewer='test')
        self.assertEqual(self.repo.find_candidate(cid).metadata['review_status'],'rejected')
        lint = self.con.lint()
        self.assertTrue(lint['success'])
        self.assertIsInstance(self.con.digest(force=True),str)
        self.assertIsNotNone(self.con.automation_status()['last_lint_at'])

    def test_scope_secrets_and_lock(self):
        with self.assertRaises(WikiAccessError): self.candidate('password=synthetic-secret')
        other = WikiRepository(WikiSettings(profile_root=self.root.parent, wiki_path=self.root, profile_name='other', propose_enabled=True))
        cid = other.propose(title='英语偏好',content='其他用户偏好英语答复。',facets={'scope':'profile:other'})['candidate_id']
        with self.assertRaises(WikiAccessError): self.repo.find_candidate(cid)
        lock, second = WikiLock(self.root), WikiLock(self.root)
        self.assertTrue(lock.acquire()); self.assertFalse(second.acquire()); lock.release()
        self.assertTrue(second.acquire()); second.release()

if __name__ == '__main__': unittest.main()
