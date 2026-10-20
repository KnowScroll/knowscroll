import { configure, fireEvent, screen } from '@testing-library/react-native';
import { ScrollArticle } from '../article';
import { barChart, heatmapChart, horizontalBarChart, lineChart, scatterChart } from '../fixtures/blocks';
import { anyNumber, articleOf, observerDouble, show } from '../../test-support/scroll';

/** The chart: drawn from the data, never a control of its own, with its table as its text version. */

beforeAll(() => {
  configure({ defaultIncludeHiddenElements: true });
});

afterAll(() => {
  configure({ defaultIncludeHiddenElements: false });
});

const images = () =>
  screen.getAllByLabelText('Chart: how four designs score').filter((node) => node.props.accessibilityRole === 'image');

describe('a chart', () => {
  it('is an image for assistive technology, named and described, with its title, legend and caption in words', async () => {
    await show(<ScrollArticle document={articleOf([barChart('chart-designs')])} />);

    expect(images()).toHaveLength(1);
    expect(images()[0]).toHaveProp(
      'accessibilityHint',
      'Grouped bars: strength and cost for an arch, a beam, a truss and a cable design.',
    );
    expect(screen.getByText('How four designs score')).toBeOnTheScreen();
    expect(screen.getByText('Strength')).toBeOnTheScreen();
    expect(screen.getByText('Cost')).toBeOnTheScreen();
    expect(screen.getByText('Scores are illustrative.')).toBeOnTheScreen();
  });

  it('shows its data as a table on request (a generated text version), reports it, and takes it back', async () => {
    const watcher = observerDouble();
    await show(<ScrollArticle document={articleOf([barChart('chart-designs')])} observer={watcher} />);
    expect(screen.queryByText('Strength (of 10)')).toBeNull();

    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Show data as a table' }));

    expect(screen.getByText('Strength (of 10)')).toBeOnTheScreen();
    expect(screen.getByText('Cost (of 10)')).toBeOnTheScreen();
    expect(screen.getByText('Score')).toBeOnTheScreen();
    expect(screen.getByText('Cable')).toBeOnTheScreen();
    expect(
      screen
        .queryAllByLabelText('Chart: how four designs score')
        .filter((node) => node.props.accessibilityRole === 'image'),
    ).toHaveLength(0);
    expect(watcher.onBlockInteraction).toHaveBeenCalledWith({
      blockId: 'chart-designs',
      kind: 'text_version',
      at: anyNumber,
    });

    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Show the chart' }));
    expect(screen.queryByText('Strength (of 10)')).toBeNull();
    expect(images()).toHaveLength(1);
  });

  it('is its table under the article’s text version, with no toggle of its own', async () => {
    await show(<ScrollArticle document={articleOf([barChart('chart-designs')])} initialTextVersion />);

    expect(screen.getByText('Strength (of 10)')).toBeOnTheScreen();
    expect(screen.queryByRole('togglebutton', { name: /table|chart/i })).toBeNull();
  });

  it('has no "inspect" control and no comparison glyph (v1): its only control is the table', async () => {
    await show(<ScrollArticle document={articleOf([barChart('chart-designs')])} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText(/inspect|compare/i)).toBeNull();
  });

  it('declares no gesture, for every kind of chart', () => {
    for (const chart of [
      barChart('a1'),
      horizontalBarChart('a2'),
      lineChart('a3'),
      scatterChart('a4'),
      heatmapChart('a5'),
    ]) {
      expect(chart.gesture).toBe('none');
    }
  });

  it('draws every kind of chart without leaving a blank: bar, horizontal log bar, line, scatter, heatmap', async () => {
    await show(
      <ScrollArticle
        document={articleOf([
          barChart('chart-bar'),
          horizontalBarChart('chart-span'),
          lineChart('chart-line'),
          scatterChart('chart-scatter'),
          heatmapChart('chart-heat'),
        ])}
      />,
    );

    for (const title of [
      'How four designs score',
      'How far each design reaches',
      'Deck weight by span',
      'Age and findings',
      'Where the stress goes',
    ]) {
      expect(screen.getByText(title)).toBeOnTheScreen();
    }
    // Several series name their series; a single one does not need a legend.
    expect(screen.getAllByText('Steel')).toHaveLength(2);
    expect(screen.queryByText('Span')).toBeNull();
  });
});
