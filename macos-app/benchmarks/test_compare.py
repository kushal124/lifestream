"""Synthetic offline checks for benchmark boundaries and provider comparison."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


COMPARE_SCRIPT = Path(__file__).with_name('compare.py')
spec = importlib.util.spec_from_file_location('recorder_compare', COMPARE_SCRIPT)
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


class RetainedImageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = Path(self.temporary.name)

    def observation(self, name, payload=None, dependency=None, suffix='lsf'):
        bundle = self.store/'1970-01-01'/name
        bundle.mkdir(parents=True)
        image = f'1970-01-01/{name}/image.{suffix}'
        record = {'capturedAt':10000,'status':'captured','imageFile':image,
                  'width':2,'height':2,'imageReference':dependency}
        path = bundle/'observation.json'
        path.write_text(json.dumps(record))
        if payload is not None:
            (self.store/image).write_bytes(payload)
        return path, record

    def archived(self, entry, segment, ordinal, count):
        path, record = entry
        sidecar = path.parent/'image.archive'
        sidecar.write_text(json.dumps({'imagePath':record['imageFile'],
            'metadataSHA256':base64.b64encode(hashlib.sha256(path.read_bytes()).digest()).decode(),
            'reference':{'segment':segment,'ordinal':ordinal,'frameCount':count}}))
        return sidecar

    def video(self, name, size):
        path = self.store/'.video'/name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b'v' * size)
        return '.video/' + name

    def measure(self, selected):
        return compare.retained_images(self.store, selected, Path('/unused-synthetic-decoder'))

    def test_compacted_images_count_shared_segment_once_and_allocate_window_frames(self):
        segment = self.video('synthetic.mov', 600)
        first, second = self.observation('first'), self.observation('second')
        references = [self.archived(first, segment, 1, 6), self.archived(second, segment, 3, 6)]
        result = self.measure([first, second])
        self.assertEqual(result['referenced_image_bytes'], 600)
        self.assertEqual(result['proportional_image_bytes'], 200)
        self.assertEqual(result['referenced_video_frames'], 2)
        self.assertEqual(result['referenced_video_segments'], 1)
        self.assertEqual(result['archive_reference_bytes'], sum(p.stat().st_size for p in references))
        self.assertEqual(result['pending_image_dependency_closure_bytes'], 0)
        self.assertEqual(result['missing_asset_references_at_measurement'], 0)

    def test_same_video_ordinal_is_not_allocated_twice_and_cleanup_is_separate(self):
        segment = self.video('synthetic.mov', 300)
        first, second = self.observation('first', b'old-pending'), self.observation('second')
        self.archived(first, segment, 0, 3); self.archived(second, segment, 0, 3)
        result = self.measure([first, second])
        self.assertEqual(result['referenced_image_bytes'], 300)
        self.assertEqual(result['proportional_video_bytes'], 100)
        self.assertEqual(result['superseded_pending_image_bytes'], len(b'old-pending'))
        self.assertEqual(result['pending_image_bytes'], 0)

    def test_pending_delta_closure_includes_shared_ancestor_outside_window_once(self):
        base = self.observation('before-window', b'a' * 30)
        first = self.observation('first', b'd' * 12, base[1]['imageFile'])
        second = self.observation('second', b'd' * 20, base[1]['imageFile'])
        still = self.observation('still', b'p' * 10, suffix='png')
        result = self.measure([first, second, still])
        self.assertEqual(result['pending_image_bytes'], 42)
        self.assertEqual(result['pending_image_dependency_bytes'], 30)
        self.assertEqual(result['pending_image_dependency_closure_bytes'], 72)
        self.assertEqual(result['referenced_image_bytes'], 72)
        self.assertEqual(result['dependency_metadata_bytes'], base[0].stat().st_size)
        with_base = self.measure([base, first, second, still])
        self.assertEqual(with_base['referenced_image_bytes'], 72)
        self.assertEqual(with_base['pending_image_dependency_bytes'], 0)

    def test_explicit_video_pointer_is_metadata_not_image_payload(self):
        segment = self.video('synthetic.mov', 900)
        reference = json.dumps({'segment':segment,'ordinal':2,'frameCount':3}).encode()
        entry = self.observation('archived', reference, suffix='video')
        result = self.measure([entry])
        self.assertEqual(result['referenced_image_bytes'], 900)
        self.assertEqual(result['proportional_image_bytes'], 300)
        self.assertEqual(result['archive_reference_bytes'], len(reference))
        self.assertEqual(result['pending_image_bytes'], 0)

    def test_missing_video_is_explicit_instead_of_a_zero_cost_success(self):
        entry = self.observation('missing')
        self.archived(entry, '.video/missing.mov', 0, 1)
        result = self.measure([entry])
        self.assertEqual(result['missing_asset_references_at_measurement'], 1)
        self.assertEqual(result['asset_accounting_errors'], {'missing-file':1})
        self.assertEqual(result['referenced_image_bytes'], 0)

    def test_sidecar_must_be_bound_to_its_original_metadata(self):
        segment = self.video('synthetic.mov', 100)
        entry = self.observation('changed')
        self.archived(entry, segment, 0, 1)
        entry[0].write_text(entry[0].read_text() + '\n')
        result = self.measure([entry])
        self.assertEqual(result['missing_asset_references_at_measurement'], 1)
        self.assertEqual(result['referenced_video_bytes'], 0)

    def test_dependency_cycle_and_path_escape_are_bounded_errors(self):
        first = self.observation('first', b'one', '1970-01-01/second/image.lsf')
        self.observation('second', b'two', first[1]['imageFile'])
        cyclic = self.measure([first])
        self.assertEqual(cyclic['missing_asset_references_at_measurement'], 1)
        self.assertEqual(cyclic['pending_image_dependency_closure_bytes'], 6)
        escaped = self.observation('escape', b'three', '../outside/image.lsf')
        result = self.measure([escaped])
        self.assertEqual(result['missing_asset_references_at_measurement'], 1)
        self.assertEqual(result['asset_accounting_errors'], {'invalid-reference-or-metadata':1})


class ComparisonTests(unittest.TestCase):
    def test_window_case_matching_and_read_only_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            coast, own = root/'coast', root/'own'
            coast.mkdir(); own.mkdir()
            (coast/'frames').mkdir()
            (coast/'frames/frame.png').write_bytes(b'synthetic-image')
            (coast/'videos').mkdir(); (coast/'videos/synthetic.mov').write_bytes(b'v' * 600)
            (own/'.video').mkdir(); (own/'.video/synthetic.mov').write_bytes(b'v' * 600)
            database = coast/'rem.db'
            connection = sqlite3.connect(database)
            connection.executescript('''
                CREATE TABLE frame(id INTEGER, timestamp REAL, foreground TEXT, background TEXT,
                    is_inactive INTEGER, video INTEGER, image_path TEXT, width INTEGER,
                    height INTEGER, ax_root_hash TEXT, segment INTEGER);
                CREATE TABLE segment(id INTEGER, application INTEGER);
                CREATE TABLE application(id INTEGER, bundle_id TEXT);
                CREATE TABLE ax_snapshot(frame_id INTEGER, is_partial_tree INTEGER, extraction_mode TEXT);
                CREATE TABLE video(id INTEGER, path TEXT, num_frames INTEGER);
                CREATE TABLE window_bound(frame INTEGER);
                CREATE TABLE ax_node(payload BLOB, first_seen_frame_id INTEGER);
                INSERT INTO application VALUES(1,'org.example.synthetic');
                INSERT INTO segment VALUES(1,1);
                INSERT INTO video VALUES(1,'synthetic.mov',3);
                INSERT INTO frame VALUES(1,10000,'synthetic alpha',NULL,0,1,NULL,2,2,NULL,1);
                INSERT INTO frame VALUES(2,20000,'outside window',NULL,0,NULL,'frame.png',2,2,NULL,1);
            ''')
            connection.commit(); connection.close()
            before = hashlib.sha256(database.read_bytes()).hexdigest()
            for index, stamp in [(1,10000),(2,20000)]:
                folder = own/'1970-01-01'/str(index); folder.mkdir(parents=True)
                (folder/'image.png').write_bytes(b'synthetic-image')
                (folder/'observation.json').write_text(json.dumps({
                    'capturedAt':stamp,'status':'captured','displayID':1,'width':2,'height':2,
                    'imageFile':f'1970-01-01/{index}/image.png','ocrStatus':'complete',
                    'application':{'bundleID':'org.example.Synthetic'},
                    'ocr':[{'text':'synthetic alpha'}],
                    'accessibility':{'status':'complete','nodes':[{'text':'synthetic alpha'}]}}))
                if index == 1:
                    (folder/'image.png').unlink()
                    (folder/'image.archive').write_text(json.dumps({
                        'imagePath':f'1970-01-01/{index}/image.png',
                        'metadataSHA256':base64.b64encode(hashlib.sha256((folder/'observation.json').read_bytes()).digest()).decode(),
                        'reference':{'segment':'.video/synthetic.mov','ordinal':0,'frameCount':3}}))
            (root/'window.json').write_text(json.dumps({'start':10,'end':20}))
            result = subprocess.run([sys.executable,str(COMPARE_SCRIPT),
                '--directory',str(root),'--coast-store',str(coast),'--own-store',str(own)],
                capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            report = json.loads((root/'comparison.json').read_text())
            self.assertEqual(report['own']['image_bytes'],600)
            self.assertEqual(report['own']['referenced_image_bytes'],report['coast']['referenced_image_bytes'])
            self.assertEqual(report['own']['proportional_image_bytes'],report['coast']['proportional_image_bytes'])
            self.assertEqual(report['coast']['frames'],1)
            self.assertEqual(report['own']['frames'],1)
            self.assertEqual(report['paired']['same_known_focus_app_pairs'],1)
            self.assertEqual(report['paired']['exact_case_focus_app_pairs'],0)
            self.assertEqual(report['paired']['ocr_token_jaccard_agreement']['median'],1)
            self.assertEqual(report['coast']['missing_asset_references_at_measurement'],0)
            self.assertEqual(hashlib.sha256(database.read_bytes()).hexdigest(),before)
            self.assertNotIn('synthetic alpha',result.stdout)
            metadata = own/'1970-01-01/1/observation.json'
            observation = json.loads(metadata.read_text())
            observation['status'] = 'cached-idle'
            metadata.write_text(json.dumps(observation))
            sidecar = metadata.parent/'image.archive'
            entry = json.loads(sidecar.read_text())
            entry['metadataSHA256'] = base64.b64encode(hashlib.sha256(metadata.read_bytes()).digest()).decode()
            sidecar.write_text(json.dumps(entry))
            second = subprocess.run([sys.executable,str(COMPARE_SCRIPT),
                '--directory',str(root),'--coast-store',str(coast),'--own-store',str(own)],
                capture_output=True,text=True)
            self.assertEqual(second.returncode,0,second.stderr)
            cached = json.loads((root/'comparison.json').read_text())['own']
            self.assertEqual(cached['frames'],1)
            self.assertEqual(cached['cached_idle_image_observations'],1)
            self.assertEqual(cached['new_complete_observations'],0)
            self.assertEqual(cached['unchanged_image_observations'],0)
            self.assertEqual(cached['gap_reasons'],{})
            self.assertEqual(hashlib.sha256(database.read_bytes()).hexdigest(),before)


if __name__ == '__main__':
    unittest.main()
