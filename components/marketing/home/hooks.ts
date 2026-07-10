import { useEffect, useRef, useState } from "react";

interface FinanceInputs {
  carPrice: number;
  downPayment: number;
  apr: number;
  term: number;
}

interface FinanceTotals {
  principal: number;
  monthlyInstallment: number;
  totalPaid: number;
  totalInterest: number;
  principalPercent: number;
  strokeDasharray: number;
  strokeDashoffset: number;
}

const PIPELINE_STAGE_COUNT = 4;
const FINANCE_RING_RADIUS = 40;

export function useFinanceCalculator() {
  const [carPrice, setCarPrice] = useState(95000);
  const [downPayment, setDownPayment] = useState(20000);
  const [apr, setApr] = useState(5.4);
  const [term, setTerm] = useState(60);

  const updateCarPrice = (nextCarPrice: number) => {
    setCarPrice(nextCarPrice);
    setDownPayment((currentDownPayment) => Math.min(currentDownPayment, nextCarPrice));
  };

  const updateDownPayment = (nextDownPayment: number) => {
    setDownPayment(Math.min(nextDownPayment, carPrice));
  };

  return {
    carPrice,
    downPayment,
    apr,
    term,
    setCarPrice: updateCarPrice,
    setDownPayment: updateDownPayment,
    setApr,
    setTerm,
    ...financeTotals({ carPrice, downPayment, apr, term }),
  };
}

export function usePipelineSimulation() {
  const [pipelineStage, setPipelineStage] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const advancePipelineStage = () => {
    setPipelineStage((currentStage) => (currentStage + 1) % PIPELINE_STAGE_COUNT);
  };

  const simulatePipelineAutoRun = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    let nextStage = 0;
    setPipelineStage(0);

    intervalRef.current = setInterval(() => {
      nextStage++;
      if (nextStage >= PIPELINE_STAGE_COUNT) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }

        return;
      }

      setPipelineStage(nextStage);
    }, 2000);
  };

  return { pipelineStage, advancePipelineStage, simulatePipelineAutoRun };
}

export function useRoiEstimator() {
  const [monthlySales, setMonthlySales] = useState(35);

  return {
    monthlySales,
    setMonthlySales,
    hoursSavedPerWk: Math.round(monthlySales * 0.85),
    annualSavingsDollars: Math.round(monthlySales * 38 * 12),
  };
}

function financeTotals(inputs: FinanceInputs): FinanceTotals {
  const principal = Math.max(0, inputs.carPrice - inputs.downPayment);
  const monthlyInterestRate = inputs.apr / 12 / 100;
  const paymentTotals = amortizedPaymentTotals(principal, monthlyInterestRate, inputs.term);
  const principalPercent = paymentTotals.totalPaid > 0 ? (principal / paymentTotals.totalPaid) * 100 : 100;
  const strokeDasharray = 2 * Math.PI * FINANCE_RING_RADIUS;

  return {
    principal,
    ...paymentTotals,
    principalPercent,
    strokeDasharray,
    strokeDashoffset: strokeDasharray * (1 - principalPercent / 100),
  };
}

function amortizedPaymentTotals(
  principal: number,
  monthlyInterestRate: number,
  term: number,
) {
  if (principal <= 0) {
    return { monthlyInstallment: 0, totalPaid: 0, totalInterest: 0 };
  }

  if (monthlyInterestRate === 0) {
    return { monthlyInstallment: principal / term, totalPaid: principal, totalInterest: 0 };
  }

  const compoundFactor = Math.pow(1 + monthlyInterestRate, term);
  const monthlyInstallment = (principal * monthlyInterestRate * compoundFactor) / (compoundFactor - 1);
  const totalPaid = monthlyInstallment * term;

  return { monthlyInstallment, totalPaid, totalInterest: totalPaid - principal };
}
