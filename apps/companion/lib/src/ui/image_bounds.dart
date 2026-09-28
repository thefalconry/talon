import 'package:flutter/painting.dart';

/// The largest edge, in physical pixels, any image is ever decoded to.
///
/// Many Linux GL stacks (Mesa llvmpipe, VMs, older Intel) cap textures at
/// 8192 px; a long screenshot decoded at full size (1080×20000) fails the
/// texture upload or aborts the raster thread instead of erroring cleanly
/// (#1062). 4096 leaves headroom everywhere and is still sharper than any
/// screen the viewer is shown on.
const int kMaxDecodeDimension = 4096;

/// A network image decoded no larger than the box it is drawn in.
///
/// Without this a 12 MP phone photo shown in a 340×420 bubble decodes to a
/// ~48 MB RGBA bitmap and sits in the image cache at that size. With it the
/// decode is capped at the box's physical size (aspect ratio preserved,
/// never upscaled) and at [kMaxDecodeDimension] on either edge.
///
/// [headers] go on the request — the bridge's `Authorization`, so the token
/// never has to ride in [url].
ImageProvider boundedNetworkImage(
  String url, {
  Map<String, String>? headers,
  required double maxWidth,
  required double maxHeight,
  required double devicePixelRatio,
}) {
  int px(double logical) =>
      (logical * devicePixelRatio).ceil().clamp(1, kMaxDecodeDimension);
  return ResizeImage(
    NetworkImage(url, headers: headers),
    width: px(maxWidth),
    height: px(maxHeight),
    policy: ResizeImagePolicy.fit,
  );
}

/// The full-screen viewer's image: full detail for zooming, but still within
/// [kMaxDecodeDimension] so it can always become a texture.
ImageProvider fullScreenNetworkImage(
  String url, {
  Map<String, String>? headers,
}) =>
    ResizeImage(
      NetworkImage(url, headers: headers),
      width: kMaxDecodeDimension,
      height: kMaxDecodeDimension,
      policy: ResizeImagePolicy.fit,
    );

/// Image-cache budget for desktop. Flutter's default is 100 MB; with decodes
/// now bounded to their on-screen size 64 MB holds far more thumbnails than
/// fit in a chat viewport, and keeps a long-running tray-resident window from
/// sitting on 100 MB of bitmaps.
const int kDesktopImageCacheBytes = 64 << 20;
