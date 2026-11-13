"""R9/R10/R12/R20: bounded frame reading and optional installed-runtime checks."""
import array, importlib.util, json, os, subprocess, tempfile, unittest, wave
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SCRIPT=ROOT/'runner/xasr_transcribe.py'
class XasrChunks(unittest.TestCase):
    def module(self):
        spec=importlib.util.spec_from_file_location('xasr',SCRIPT);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
    def test_R10_silence_noise_and_mid_silence_cover_the_entire_file(self):
        m=self.module()
        for seconds,kind in [(100,'silence'),(100,'noise'),(95,'middle')]:
            reads=[]
            def frames(start,n):
                reads.append(n);return array.array('h',(0 if kind=='silence' or kind=='middle' and 29*16000<=start+i<31*16000 else 100 for i in range(n)))
            chunks=list(m.chunk_plan(frames,seconds*16000));self.assertEqual(chunks[0][0],0);self.assertEqual(chunks[-1][1],seconds*16000)
            self.assertTrue(all(0<end-start<=35*16000 for start,end in chunks));self.assertTrue(all(chunks[i][1]==chunks[i+1][0] for i in range(len(chunks)-1)))
            self.assertTrue(all(n<=32*16000 for n in reads))
    def test_R20_ninety_minutes_plan_reads_at_most_one_window(self):
        m=self.module();reads=[]
        def frames(_start,n):reads.append(n);return array.array('h',[0])*n
        chunks=list(m.chunk_plan(frames,90*60*16000));self.assertEqual(chunks[-1][1],90*60*16000);self.assertLessEqual(max(reads),32*16000)
        self.assertNotIn('[s / 32768.0 for s in',SCRIPT.read_text())
    def test_R9_missing_models_names_files_without_importing_the_runtime(self):
        r=subprocess.run(['/usr/local/bin/python3',str(SCRIPT),'--check','--model-dir','/nonexistent'],capture_output=True,text=True)
        self.assertEqual(r.returncode,2);self.assertIn('encoder',r.stderr);self.assertNotIn('Traceback',r.stderr)
    def test_R20_tiny_memory_limit_exits_six(self):
        with tempfile.TemporaryDirectory()as td:
            m=self.module()
            for name in m.MODEL_FILES:(Path(td)/name).write_text('synthetic model placeholder')
            r=subprocess.run(['/usr/local/bin/python3',str(SCRIPT),'--check','--model-dir',td,'--max-rss-mb','1'],capture_output=True,text=True)
            self.assertEqual(r.returncode,6)
    @unittest.skipUnless(os.environ.get('XASR_REAL_TEST')=='1','R12 installed-runtime audio samples run explicitly outside CI')
    def test_R12_real_chinese_english_and_multichunk(self):
        python=Path.home()/'.inkboard-team/xasr-venv/bin/python'
        for key in ['XASR_ZH_WAV','XASR_EN_WAV']:
            wav=Path(os.environ[key]);r=subprocess.run([str(python),str(SCRIPT),str(wav)],capture_output=True,text=True,timeout=120)
            self.assertEqual(r.returncode,0,r.stderr);result=json.loads(r.stdout.splitlines()[-1]);self.assertTrue(result['segments'])
            if key=='XASR_ZH_WAV':self.assertTrue(any(c in ''.join(s['text'] for s in result['segments']) for c in '，。！？'))
        # Same sample read repeatedly into a 65s WAV, with no model copying and bounded sample storage.
        with tempfile.TemporaryDirectory()as td:
            target=Path(td)/'65.wav'
            with wave.open(os.environ['XASR_ZH_WAV'],'rb')as f:data=f.readframes(f.getnframes())
            with wave.open(str(target),'wb')as f:f.setparams((1,2,16000,0,'NONE',''));f.writeframes((data*(65*32000//len(data)+1))[:65*32000])
            r=subprocess.run([str(python),str(SCRIPT),str(target)],capture_output=True,text=True,timeout=120);self.assertEqual(r.returncode,0,r.stderr);segments=json.loads(r.stdout.splitlines()[-1])['segments'];self.assertGreaterEqual(len(segments),2);self.assertTrue(all(segments[i]['end']<=segments[i+1]['start'] for i in range(len(segments)-1)))
if __name__=='__main__':unittest.main()
