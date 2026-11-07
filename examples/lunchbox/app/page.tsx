import { OrderForm } from '@/components/OrderForm';
import { SuggestBox } from '@/components/SuggestBox';

export default function Home() {
  return (
    <main>
      <h1>Lunchbox</h1>
      <OrderForm />
      <SuggestBox />
    </main>
  );
}
