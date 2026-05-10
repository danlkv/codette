// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import 'katex/dist/katex.min.css';
import './mermaid.css';
import { mount } from 'svelte';
import App from './App.svelte';
const app = mount(App, { target: document.getElementById('app') });
export default app;
