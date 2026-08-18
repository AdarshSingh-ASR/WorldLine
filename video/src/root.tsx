import React from 'react';
import {Composition} from 'remotion';
import {WorldlineDemo} from './worldline-demo';

export const FPS = 30;
export const DURATION = 137 * FPS;
export const Root: React.FC = () => <Composition id="WorldlineDemo" component={WorldlineDemo} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />;
