'use client';

import { useState } from 'react';
import { useAppContext } from '../AppContext';
import { WelcomeStep } from './WelcomeStep';
import { LlmSetupStep } from './LlmSetupStep';
import { AddProjectStep } from './AddProjectStep';
import type { OnboardingStep } from '../AppContext';
import styles from './OnboardingFlow.module.css';

export function OnboardingFlow(): JSX.Element {
  const { onboardingStep, dispatch, config } = useAppContext();
  const [step, setStep] = useState<OnboardingStep>(onboardingStep);

  const advance = (next: OnboardingStep) => {
    setStep(next);
    dispatch({ type: 'advanceOnboarding', step: next });
  };

  const hasKey = Boolean(
    config && (config.apiKeys.hasAnthropicKey || config.apiKeys.hasOpenAIKey)
  );

  return (
    <div className={styles.wrap} data-testid="onboarding-flow">
      {step === 'welcome' && <WelcomeStep onContinue={() => advance(hasKey ? 'add-project' : 'llm')} />}
      {step === 'llm' && <LlmSetupStep onContinue={() => advance('add-project')} />}
      {step === 'add-project' && <AddProjectStep />}
    </div>
  );
}
