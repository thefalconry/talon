#!/bin/sh
# Launcher script for installed Linux package (/usr/bin/talon-companion)
HERE="/usr/lib/talon-companion"
export LD_LIBRARY_PATH="${HERE}/lib:${LD_LIBRARY_PATH}"
exec "${HERE}/talon_companion" "$@"
