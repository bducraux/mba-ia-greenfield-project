/** Subset of `ffprobe -print_format json -show_format -show_streams` the worker reads. */
export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

export interface FfprobeFormat {
  format_name?: string;
  duration?: string;
}

export interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}
