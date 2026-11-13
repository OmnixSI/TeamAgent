#!/usr/bin/env python3
"""Bounded offline X-ASR transcription, using only already-installed local models."""
import argparse,array,gc,json,os,resource,sys,time,wave
from pathlib import Path
MODEL_FILES=('encoder-epoch-99-avg-1.int8.onnx','decoder-epoch-99-avg-1.onnx','joiner-epoch-99-avg-1.int8.onnx','tokens.txt','bpe.vocab')
DEFAULT=Path.home()/'Library/Application Support/NextThought/models/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03'
def max_rss_mb():
    value=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value/(1024*1024 if sys.platform=='darwin' else 1024)
def check_rss(cap):
    if max_rss_mb()>cap:raise SystemExit(6)
def chunk_plan(read_frames,total,chunk_s=30,search_s=2,hard_s=35):
    """Yield adjacent frame ranges; a quiet 100ms cut, at most a 32s read."""
    rate=16000;pos=0;window=int((chunk_s+search_s)*rate);frame=1600
    while pos<total:
        if total-pos<=min(window,int(hard_s*rate)):
            yield pos,total;return
        samples=read_frames(pos,min(window,total-pos))
        lo=int((chunk_s-search_s)*rate);hi=min(len(samples)-frame,int(hard_s*rate)-frame)
        target=int(chunk_s*rate)
        choices=[]
        for at in range(lo,hi+1,frame//2):
            block=samples[at:at+frame];energy=sum(v*v for v in block)/max(1,len(block));choices.append((energy,abs(at-target),at))
        end=pos+(min(choices)[2] if choices else min(window,total-pos))
        del samples,choices
        if end<=pos:end=min(total,pos+window)
        yield pos,end;pos=end

def build(model_dir):
    import sherpa_onnx
    files=[str(model_dir/name)for name in MODEL_FILES]
    return sherpa_onnx.OfflineRecognizer.from_transducer(encoder=files[0],decoder=files[1],joiner=files[2],tokens=files[3],num_threads=2,sample_rate=16000,feature_dim=80,decoding_method='modified_beam_search',max_active_paths=4,modeling_unit='bpe',bpe_vocab=files[4],provider='cpu',model_type='transducer')
def main(argv=None):
    p=argparse.ArgumentParser();p.add_argument('wav',nargs='?');p.add_argument('--model-dir',type=Path,default=DEFAULT);p.add_argument('--check',action='store_true');p.add_argument('--max-rss-mb',type=float,default=1300);args=p.parse_args(argv)
    missing=[name for name in MODEL_FILES if not (args.model_dir/name).is_file()]
    if missing:print('Missing model files: '+', '.join(missing),file=sys.stderr);return 2
    check_rss(args.max_rss_mb)
    try:rec=build(args.model_dir)
    except ImportError:print('Local ASR runtime is missing',file=sys.stderr);return 5
    except Exception:print('Local ASR model could not be loaded',file=sys.stderr);return 4
    check_rss(args.max_rss_mb)
    if args.check:return 0
    if not args.wav:return 3
    try:
        with wave.open(args.wav,'rb')as f:
            if (f.getnchannels(),f.getframerate(),f.getsampwidth(),f.getcomptype())!=(1,16000,2,'NONE'):return 3
            total=f.getnframes()
            def read_frames(start,n):
                f.setpos(start);data=array.array('h');data.frombytes(f.readframes(n))
                if sys.byteorder!='little':data.byteswap()
                return data
            # The ranges are tiny metadata; audio is loaded and released one block at a time.
            ranges=list(chunk_plan(read_frames,total));segments=[];started=time.monotonic()
            for index,(start,end)in enumerate(ranges):
                block=read_frames(start,end-start);floats=list(map(lambda value:value/32768.0,block));stream=rec.create_stream();stream.accept_waveform(16000,floats);rec.decode_stream(stream);text=stream.result.text.strip()
                if text:segments.append({'start':start/16000,'end':end/16000,'text':text})
                del stream,floats,block;gc.collect();check_rss(args.max_rss_mb)
                print(json.dumps({'type':'progress','done':index+1,'total':len(ranges)}),flush=True)
            print(json.dumps({'type':'result','segments':segments,'audio_s':total/16000,'decode_s':round(time.monotonic()-started,3),'max_rss_mb':round(max_rss_mb(),2)},ensure_ascii=False),flush=True);return 0
    except (wave.Error,FileNotFoundError):print('Expected 16kHz mono PCM WAV',file=sys.stderr);return 3
    except Exception:print('Recognition failed',file=sys.stderr);return 4
if __name__=='__main__':raise SystemExit(main())
