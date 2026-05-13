#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Danylo Lykov

export SERVER_URL='wss://chat.example.com'
export HOST_KEY='<key>'
export CLIENT_USERNAME='<username>'
export CLIENT_PASSWORD='<password>'
exec node host/index.js "$@"
