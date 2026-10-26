import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function mp4QualityFixture(directory:string,codec:'h264'|'hevc',depth:8|10){
  const file=join(directory,`${codec}-${depth}.mp4`),format=depth===10?'yuv420p10le':'yuv420p';
  execFileSync('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=25','-frames:v','8','-vf','setsar=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv','-c:v',codec==='h264'?'libx264':'libx265','-threads','1','-bf','2','-g','8',...(codec==='h264'?['-x264-params','scenecut=0:open-gop=0:chromaloc=0']:['-x265-params','pools=1:frame-threads=1:scenecut=0:open-gop=0:chromaloc=0:log-level=error','-tag:v','hvc1']),'-pix_fmt',format,'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-chroma_sample_location','left','-use_editlist','0','-video_track_timescale','1000000','-movflags','+faststart+write_colr',file],{stdio:'pipe'});
  const native=execFileSync('ffmpeg',['-v','error','-i',file,'-pix_fmt',format,'-f','rawvideo','-'],{stdio:'pipe'}),packets=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts,dts,duration,pos,size,flags','-of','json',file],{encoding:'utf8'})).packets;
  return {file,bytes:await readFile(file),native,packets,format};
}
