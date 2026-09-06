import { Input, InputProps } from "@chakra-ui/react";
import { forwardRef, useEffect, useRef } from "react";

import { createImeGate } from "./imeGate";

export type ImeInputProps = Omit<
  InputProps,
  "onChange" | "value" | "defaultValue"
> & {
  value: string;
  onValueChange: (value: string) => void;
};

const ImeInput = forwardRef<HTMLInputElement, ImeInputProps>(function ImeInput(
  {
    value,
    onValueChange,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    ...rest
  },
  forwardedRef,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  const gateRef = useRef(createImeGate());
  const lastEmittedRef = useRef(value);

  useEffect(() => {
    const el = innerRef.current;
    if (!el || !gateRef.current.shouldApplyExternalValue()) return;
    if (el.value !== value) {
      el.value = value;
    }
    lastEmittedRef.current = value;
  }, [value]);

  function setRef(el: HTMLInputElement | null) {
    innerRef.current = el;
    if (typeof forwardedRef === "function") {
      forwardedRef(el);
    } else if (forwardedRef) {
      forwardedRef.current = el;
    }
  }

  function emit(next: string) {
    if (next === lastEmittedRef.current) return;
    lastEmittedRef.current = next;
    onValueChange(next);
  }

  return (
    <Input
      {...rest}
      ref={setRef}
      defaultValue={value}
      onCompositionStart={(event) => {
        gateRef.current.start();
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        gateRef.current.end();
        emit(event.currentTarget.value);
        onCompositionEnd?.(event);
      }}
      onChange={(event) => {
        if (
          !gateRef.current.shouldEmitChange(
            Boolean((event.nativeEvent as InputEvent).isComposing),
          )
        ) {
          return;
        }
        emit(event.target.value);
      }}
      onBlur={(event) => {
        gateRef.current.end();
        emit(event.currentTarget.value);
        onBlur?.(event);
      }}
    />
  );
});

export default ImeInput;
